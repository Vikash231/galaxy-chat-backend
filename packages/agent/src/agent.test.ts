import { describe, expect, it, vi } from "vitest";
import type { ContentBlock, StreamPart } from "@gx/contracts";
import type { LlmProvider, StepResult, LlmMessage } from "@gx/llm";
import { runAgentTurn, type TurnPorts } from "./loop";
import type { ToolPorts, ToolOutcome } from "./executor";
import { toLlmMessages } from "./history";

const step = (p: Partial<StepResult>): StepResult => ({ text: "", thinking: "", toolCalls: [], model: "m:free", usage: { promptTokens: 1, completionTokens: 1 }, finishReason: "stop", ...p });
const cropArgs = (x = 0) => JSON.stringify({ image_url: "https://e.com/a.jpg", unit: "percent", x, y: 0, width: 50, height: 100 });

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
  const ports: ToolPorts = {
    balance: async () => opts.balance ?? 1_000_000n,
    upsert: vi.fn(async () => ({ id: `inv_${n++}`, status: "pending" as const, output: null, creditsMicro: 0n, error: null })),
    dispatch: vi.fn(async (_t, id) => opts.outcome?.(id) ?? { status: "completed" as const, output: { image_url: `https://cdn/${id}.png` }, creditsMicro: 5_000n }),
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
    expect(out.blocks.map((b) => b.type)).toEqual(["tool_use", "tool_result", "asset", "text"]);
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
    expect((seen[1]!.at(-1) as { content: string }).content).toContain("image_url");
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
    expect(out.blocks.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("step limit") });
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
