import { describe, expect, it, vi } from "vitest";
import type { ContentBlock, StreamPart } from "@gx/contracts";
import type { LlmProvider, StepResult, LlmMessage } from "@gx/llm";
import { installSkills, skillIndex, toolSpecs, type LocalExec } from "@gx/tools";
import type { SkillSet } from "@gx/skills";
import { runAgentTurn, systemPrompt, type TurnPorts } from "./loop";
import type { ToolPorts, ToolOutcome } from "./executor";
import { toLlmMessages } from "./history";

const step = (p: Partial<StepResult>): StepResult => ({ text: "", thinking: "", toolCalls: [], model: "m:free", usage: { promptTokens: 1, completionTokens: 1 }, finishReason: "stop", ...p });
const cropArgs = (x = 0, image = "https://e.com/a.jpg") => JSON.stringify({ image, unit: "percent", x, y: 0, width: 50, height: 100 });

function fakeLlm(steps: StepResult[]) {
  const seen: LlmMessage[][] = [];
  const llm: LlmProvider = {
    async streamStep(req, onDelta) {
      seen.push(structuredClone(req.messages));
      const s = steps.shift() ?? step({ text: "done" });
      if (s.text) onDelta({ type: "text", delta: s.text });
      return s;
    },
  };
  return { llm, seen };
}

function fakeTools(opts: { balance?: bigint; outcome?: (id: string) => ToolOutcome } = {}) {
  let n = 0;
  let fileSeq = 0;
  const recorded = new Map<string, { contentHash: string; content: string }>();
  const ports: ToolPorts = {
    reserveFileRefs: vi.fn(async (kinds) => kinds.map(() => `img_${++fileSeq}`)),
    balance: async () => opts.balance ?? 1_000_000n,
    upsert: vi.fn(async () => ({ id: `inv_${n++}`, status: "pending" as const, output: null, creditsMicro: 0n, error: null })),
    dispatch: vi.fn(async (_t, id) => opts.outcome?.(id) ?? { status: "completed" as const, output: { image_url: `https://cdn/${id}.png` }, creditsMicro: 5_000n }),
    runLocal: vi.fn(async (tool, args) => {
      const exec = tool.exec as LocalExec<never, unknown>;
      const output = await exec.run(args as never, {
        recordSkill: async (name, contentHash, content) => {
          const first = !recorded.has(name);
          if (first) recorded.set(name, { contentHash, content });
          return { ...recorded.get(name)!, first };
        },
      });
      return { status: "completed" as const, output, creditsMicro: 0n };
    }),
    settle: vi.fn(async () => {}),
    update: vi.fn(),
  };
  return ports;
}

function ports(llm: LlmProvider, tools: ToolPorts, over: Partial<TurnPorts> = {}): TurnPorts & { parts: StreamPart[]; checkpoints: ContentBlock[][] } {
  const parts: StreamPart[] = [];
  const checkpoints: ContentBlock[][] = [];
  return {
    llm, tools, parts, checkpoints,
    toolSpecs: [],
    maxSteps: 8,
    history: async () => [{ role: "user", content: [{ type: "text", text: "crop it" }] }],
    emit: (p) => parts.push(p),
    meta: () => {},
    checkpoint: async (b) => void checkpoints.push(structuredClone(b)),
    ...over,
  };
}

describe("agent loop", () => {
  it("calls a tool, feeds the result back, then answers", async () => {
    const { llm, seen } = fakeLlm([step({ toolCalls: [{ id: "c1", name: "crop_image", argsJson: cropArgs() }] }), step({ text: "Here it is." })]);
    const tools = fakeTools();
    const p = ports(llm, tools);
    const out = await runAgentTurn(p);

    expect(out.status).toBe("completed");
    expect(out.blocks.map((b) => b.type)).toEqual(["tool_use", "tool_result", "asset", "text", "usage"]);
    expect(out.blocks[1]).toMatchObject({ type: "tool_result", creditsMicro: 5000 });
    expect(out.blocks[2]).toMatchObject({ type: "asset", ref: "img_1" });
    expect(out.blocks.at(-1)).toEqual({ type: "usage", creditsMicro: 5000, promptTokens: 2, completionTokens: 2, models: ["m:free"] });
    expect(tools.settle).toHaveBeenCalledWith("inv_0", 5_000n);
    const second = seen[1]!;
    const assistant = second.at(-2) as Extract<LlmMessage, { role: "assistant" }>;
    const tool = second.at(-1) as Extract<LlmMessage, { role: "tool" }>;
    expect(tool.tool_call_id).toBe(assistant.tool_calls![0]!.id);
    expect(p.parts.every((x) => typeof x.step === "number")).toBe(true);
    expect(p.checkpoints.length).toBeGreaterThanOrEqual(3);
  });

  it("returns invalid arguments to the model instead of calling the provider", async () => {
    const { llm, seen } = fakeLlm([step({ toolCalls: [{ id: "c1", name: "crop_image", argsJson: '{"unit":"percent"}' }] }), step({ text: "Which image?" })]);
    const tools = fakeTools();
    const out = await runAgentTurn(ports(llm, tools));
    expect(tools.dispatch).not.toHaveBeenCalled();
    expect(out.blocks[1]).toMatchObject({ type: "tool_result", status: "failed", error: { code: "invalid_input" } });
    expect((seen[1]!.at(-1) as { content: string }).content).toContain("image:");
  });

  it("reports unknown tools back to the model", async () => {
    const { llm } = fakeLlm([step({ toolCalls: [{ id: "c1", name: "teleport", argsJson: "{}" }] }), step({ text: "ok" })]);
    const out = await runAgentTurn(ports(llm, fakeTools()));
    expect(out.blocks[1]).toMatchObject({ type: "tool_result", error: { code: "unknown_tool" } });
  });

  it("stops safely when credits run out and keeps completed work", async () => {
    const { llm } = fakeLlm([step({ text: "Cropping.", toolCalls: [{ id: "c1", name: "crop_image", argsJson: cropArgs() }] })]);
    const tools = fakeTools({ balance: 100n });
    const out = await runAgentTurn(ports(llm, tools));
    expect(out).toMatchObject({ status: "failed", error: { code: "insufficient_credits" } });
    expect(out.blocks[0]).toEqual({ type: "text", text: "Cropping." });
    expect(tools.dispatch).not.toHaveBeenCalled();
  });

  it("runs parallel calls but keeps results in call order", async () => {
    const calls = [0, 1, 2].map((i) => ({ id: `c${i}`, name: "crop_image", argsJson: cropArgs(i) }));
    const { llm } = fakeLlm([step({ toolCalls: calls }), step({ text: "done" })]);
    const tools = fakeTools();
    (tools.dispatch as ReturnType<typeof vi.fn>).mockImplementation(async (_t: unknown, id: string) => {
      await new Promise((r) => setTimeout(r, id === "inv_0" ? 30 : 1));
      return { status: "completed", output: { image_url: `https://cdn/${id}.png` }, creditsMicro: 5_000n };
    });
    const out = await runAgentTurn(ports(llm, tools));
    const results = out.blocks.filter((b) => b.type === "tool_result").map((b) => (b as { toolCallId: string }).toolCallId);
    expect(results).toEqual(["0:c0", "0:c1", "0:c2"]);
  });

  it("totals credits across parallel tool calls in the usage block", async () => {
    const calls = [0, 1].map((i) => ({ id: `c${i}`, name: "crop_image", argsJson: cropArgs(i) }));
    const { llm } = fakeLlm([step({ toolCalls: calls }), step({ text: "done" })]);
    const out = await runAgentTurn(ports(llm, fakeTools()));
    expect(out.blocks.at(-1)).toMatchObject({ type: "usage", creditsMicro: 10_000 });
  });

  it("records zero credits for a plain answer", async () => {
    const { llm } = fakeLlm([step({ text: "4" })]);
    const out = await runAgentTurn(ports(llm, fakeTools()));
    expect(out.blocks).toEqual([{ type: "text", text: "4" }, { type: "usage", creditsMicro: 0, promptTokens: 1, completionTokens: 1, models: ["m:free"] }]);
  });

  it("does not charge failed provider runs", async () => {
    const { llm } = fakeLlm([step({ toolCalls: [{ id: "c1", name: "crop_image", argsJson: cropArgs() }] }), step({ text: "Sorry." })]);
    const tools = fakeTools({ outcome: () => ({ status: "failed", creditsMicro: 0n, error: { code: "provider_failed", message: "bad image", retryable: true } }) });
    const out = await runAgentTurn(ports(llm, tools));
    expect(tools.settle).not.toHaveBeenCalled();
    expect(out.status).toBe("completed");
  });

  it("stops at the step limit", async () => {
    const loop = () => step({ toolCalls: [{ id: "c", name: "crop_image", argsJson: cropArgs() }] });
    const { llm } = fakeLlm([loop(), loop(), loop()]);
    const out = await runAgentTurn(ports(llm, fakeTools(), { maxSteps: 2 }));
    expect(out.blocks.at(-2)).toMatchObject({ type: "text", text: expect.stringContaining("step limit") });
    expect(out.blocks.at(-1)).toMatchObject({ type: "usage" });
  });
});

describe("file names", () => {
  const attached = [{ role: "user" as const, content: [
    { type: "attachment" as const, attachmentId: "a1", ref: "img_1", kind: "image" as const, url: "https://files.example/u/cat-long-random-9f8e7d6c5b4a.jpg", name: "cat.jpg", mime: "image/jpeg", width: 400, height: 267 },
    { type: "text" as const, text: "crop the left half" },
  ] }];

  it("resolves a file name to its real URL before the tool runs", async () => {
    const { llm } = fakeLlm([step({ toolCalls: [{ id: "c1", name: "crop_image", argsJson: cropArgs(0, "img_1") }] }), step({ text: "done" })]);
    const tools = fakeTools();
    await runAgentTurn(ports(llm, tools, { history: async () => attached }));
    expect(tools.upsert).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ image: "https://files.example/u/cat-long-random-9f8e7d6c5b4a.jpg" }) }));
  });

  it("rejects an unknown name and tells the model which files exist", async () => {
    const { llm, seen } = fakeLlm([step({ toolCalls: [{ id: "c1", name: "crop_image", argsJson: cropArgs(0, "img_9") }] }), step({ text: "Which image?" })]);
    const tools = fakeTools();
    await runAgentTurn(ports(llm, tools, { history: async () => attached }));
    expect(tools.dispatch).not.toHaveBeenCalled();
    expect((seen[1]!.at(-1) as { content: string }).content).toContain("Unknown file img_9. Files in this chat: img_1.");
  });

  it("gives every result its own name and shows the model names, never URLs", async () => {
    const calls = [0, 1, 2].map((i) => ({ id: `c${i}`, name: "crop_image", argsJson: cropArgs(i, "img_1") }));
    const { llm, seen } = fakeLlm([step({ toolCalls: calls }), step({ text: "done" })]);
    const out = await runAgentTurn(ports(llm, fakeTools(), { history: async () => attached }));
    const refs = out.blocks.flatMap((b) => (b.type === "asset" ? [b.ref] : []));
    expect(new Set(refs).size).toBe(3);
    const toolMessages = seen[1]!.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content).join(" ");
    expect(toolMessages).toMatch(/img_\d/);
    expect(toolMessages).not.toContain("https://");
  });

  it("the model sees attachments by name only", () => {
    const [msg] = toLlmMessages(attached);
    expect(msg).toEqual({ role: "user", content: 'Attached image img_1: "cat.jpg" (400x267)\n\ncrop the left half' });
  });

  it("older files without a saved name get a stable fallback name", () => {
    const old = [{ role: "user" as const, content: [{ type: "attachment" as const, attachmentId: "a0", kind: "image" as const, url: "https://x/y.png", name: "y.png", mime: "image/png", width: null, height: null }] }];
    const a = (toLlmMessages(old)[0] as { content: string }).content;
    expect(a).toMatch(/^Attached image img_[a-f0-9]{6}: "y.png"$/);
    expect(toLlmMessages(old)).toEqual(toLlmMessages(old));
  });
});

describe("history mapping", () => {

  it("drops tool calls that never got a result so providers do not reject the history", () => {
    const msgs = toLlmMessages([
      { role: "user", content: [{ type: "text", text: "crop" }] },
      { role: "assistant", content: [{ type: "text", text: "On it." }, { type: "tool_use", toolCallId: "0:a", name: "crop_image", input: {} }] },
    ]);
    expect(msgs).toEqual([{ role: "user", content: "crop" }, { role: "assistant", content: "On it." }]);
  });

  it("replays answered tool calls with matching ids and skips thinking", () => {
    const msgs = toLlmMessages([
      { role: "assistant", content: [
        { type: "thinking", text: "hmm" },
        { type: "tool_use", toolCallId: "0:a", name: "crop_image", input: { x: 1 } },
        { type: "tool_result", toolCallId: "0:a", status: "completed", output: { image_url: "https://x/y.png" } },
        { type: "text", text: "Done." },
      ] },
    ]);
    expect(msgs).toHaveLength(3);
    const [a, t, done] = msgs as [Extract<LlmMessage, { role: "assistant" }>, Extract<LlmMessage, { role: "tool" }>, LlmMessage];
    expect(t.tool_call_id).toBe(a.tool_calls![0]!.id);
    expect(t.tool_call_id).toMatch(/^[a-z0-9]{9}$/);
    expect(done).toEqual({ role: "assistant", content: "Done." });
  });
});

describe("skills in the agent loop", () => {
  const set: SkillSet = {
    skills: new Map([
      ["social-media-sizes", { name: "social-media-sizes", description: "Platform sizes. Use when the user names a platform.", dir: "/skills/social-media-sizes", body: "GUIDE: story is 1080x1920", hash: "h1", assets: [] }],
      ["video-montage", { name: "video-montage", description: "Merging clips. Use when joining videos.", dir: "/skills/video-montage", body: "GUIDE: montage", hash: "h2", assets: [] }],
    ]),
    rejected: [],
  };
  const withSkills = (fn: () => Promise<void>) => async () => {
    installSkills(set);
    try {
      await fn();
    } finally {
      installSkills({ skills: new Map(), rejected: [] });
    }
  };
  const load = (id: string, name: string) => ({ id, name: "load_skill", argsJson: JSON.stringify({ name }) });

  it("puts only names and descriptions in the prompt, and adds the loader tools", withSkills(async () => {
    const prompt = systemPrompt(skillIndex(set));
    expect(prompt).toContain("- social-media-sizes: Platform sizes. Use when the user names a platform.");
    expect(prompt).not.toContain("GUIDE:");
    expect(toolSpecs().map((t) => t.function.name)).toEqual(["crop_image", "gpt_image_2", "merge_videos", "load_skill", "read_skill_asset"]);
    expect(systemPrompt([])).not.toContain("Skills:");
  }));

  it("loads only the skill the model asks for, free, then continues to the tool", withSkills(async () => {
    const { llm, seen } = fakeLlm([
      step({ toolCalls: [load("c1", "social-media-sizes")] }),
      step({ toolCalls: [{ id: "c2", name: "crop_image", argsJson: cropArgs() }] }),
      step({ text: "Cropped to 1080x1920." }),
    ]);
    const tools = fakeTools();
    const out = await runAgentTurn(ports(llm, tools, { skills: skillIndex(set) }));

    expect(out.status).toBe("completed");
    const toolMessages = seen[2]!.filter((m) => m.role === "tool").map((m) => m.content as string);
    expect(toolMessages[0]).toContain("GUIDE: story is 1080x1920");
    expect(JSON.stringify(seen)).not.toContain("GUIDE: montage");
    expect(tools.runLocal).toHaveBeenCalledTimes(1);
    expect(tools.dispatch).toHaveBeenCalledTimes(1); // only crop_image reaches Magica
    expect(tools.settle).toHaveBeenCalledTimes(1);
    expect(out.blocks.at(-1)).toMatchObject({ type: "usage", creditsMicro: 5000 });
  }));

  it("a second load of the same skill in a run is marked as already loaded", withSkills(async () => {
    const { llm, seen } = fakeLlm([step({ toolCalls: [load("c1", "video-montage")] }), step({ toolCalls: [load("c2", "video-montage")] }), step({ text: "ok" })]);
    await runAgentTurn(ports(llm, fakeTools(), { skills: skillIndex(set) }));
    const results = seen[2]!.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content as string));
    expect(results.map((r) => r.alreadyLoaded)).toEqual([false, true]);
  }));

  it("rejects an unknown skill before running anything", withSkills(async () => {
    const { llm, seen } = fakeLlm([step({ toolCalls: [load("c1", "nope")] }), step({ text: "ok" })]);
    const tools = fakeTools();
    await runAgentTurn(ports(llm, tools, { skills: skillIndex(set) }));
    expect(tools.runLocal).not.toHaveBeenCalled();
    expect(seen[1]!.at(-1)!.content).toContain("social-media-sizes");
  }));
});

describe("interrupted steps", () => {
  // Streams some thinking and text, then fails the way an abort (Stop) or a dropped connection does.
  const interruptingLlm = (thinking: string, text: string): LlmProvider => ({
    async streamStep(_req, onDelta) {
      if (thinking) onDelta({ type: "thinking", delta: thinking });
      for (const word of text.split(/(?<= )/)) onDelta({ type: "text", delta: word });
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });

  it("keeps the thinking and text the user already saw, then rethrows", async () => {
    const p = ports(interruptingLlm("Planning the crop", "Sure, I will crop the left half of "), fakeTools());
    await expect(runAgentTurn(p)).rejects.toThrow("aborted");
    expect(p.checkpoints.at(-1)).toEqual([
      { type: "thinking", text: "Planning the crop" },
      { type: "text", text: "Sure, I will crop the left half of" },
    ]);
  });

  it("keeps earlier completed steps and hides file names in the partial text", async () => {
    let call = 0;
    const llm: LlmProvider = {
      async streamStep(req, onDelta) {
        if (call++ === 0) return step({ toolCalls: [{ id: "c1", name: "crop_image", argsJson: cropArgs() }] });
        return interruptingLlm("", "Cropped img_1 and now ").streamStep(req, onDelta);
      },
    };
    const p = ports(llm, fakeTools());
    await expect(runAgentTurn(p)).rejects.toThrow("aborted");
    const last = p.checkpoints.at(-1)!;
    expect(last.map((b) => b.type)).toEqual(["tool_use", "tool_result", "asset", "text"]);
    expect(last.at(-1)).toEqual({ type: "text", text: "Cropped the image and now" });
  });

  it("does not write a checkpoint when nothing streamed before the failure", async () => {
    const p = ports(interruptingLlm("", ""), fakeTools());
    await expect(runAgentTurn(p)).rejects.toThrow("aborted");
    expect(p.checkpoints).toEqual([]);
  });

  it("still rethrows the original error when saving the partial output fails", async () => {
    const p = ports(interruptingLlm("", "partial"), fakeTools(), { checkpoint: async () => Promise.reject(new Error("db down")) });
    await expect(runAgentTurn(p)).rejects.toThrow("aborted");
  });
});
