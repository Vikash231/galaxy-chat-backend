import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@gx/contracts";
import type { LlmMessage, LlmProvider, StepResult } from "@gx/llm";
import { fileContext, olderFileLines, type KnownFile } from "./files";
import { fitHistory, toLlmMessages, TOOL_RESULT_MAX_CHARS, type StoredMessage } from "./history";
import { runAgentTurn, systemPrompt } from "./loop";
import { acceptSummary, keepTokens, needsSummary, planSummary, summaryMessages } from "./summary";

const user = (text: string): StoredMessage => ({ role: "user", content: [{ type: "text", text }] });
const reply = (text: string): StoredMessage => ({ role: "assistant", content: [{ type: "text", text }] });
/** n turns of a user message and a reply, each message about `tokens` tokens. */
const chat = (n: number, tokens = 10) =>
  Array.from({ length: n }, (_, i) => [user(`q${i} ${"x".repeat(tokens * 4)}`), reply(`a${i} ${"y".repeat(tokens * 4)}`)]).flat();
const toolTurn = (i: number, output: unknown): StoredMessage[] => [
  user(`crop ${i}`),
  {
    role: "assistant",
    content: [
      { type: "tool_use", toolCallId: `${i}:c`, name: "crop_image", input: { image: "img_1" } },
      { type: "tool_result", toolCallId: `${i}:c`, status: "completed", output },
      { type: "asset", kind: "image", url: `https://cdn/${i}.png`, toolCallId: `${i}:c`, ref: `img_${i + 10}` },
      { type: "text", text: "Done." },
    ],
  },
];
const textOf = (ms: LlmMessage[]) => JSON.stringify(ms);

describe("fitHistory", () => {
  it("keeps the newest turns that fit the budget and drops whole older turns", () => {
    const h = chat(10); // each turn ~2 x 12 tokens
    const out = fitHistory(h, 100);
    expect(out.messages[0]).toMatchObject({ role: "user" });
    expect(out.dropped % 2).toBe(0);
    expect(out.messages.length + out.dropped).toBe(20);
    expect(out.tokens).toBeLessThanOrEqual(100);
    expect(textOf(out.messages)).toContain("q9");
    expect(textOf(out.messages)).not.toContain("q0 ");
  });

  it("always sends the last 3 turns, even over budget", () => {
    const out = fitHistory(chat(5, 1_000), 10);
    expect(out.messages).toHaveLength(6);
    expect(textOf(out.messages)).toContain("q2");
  });

  it("never opens on a reply whose question was cut", () => {
    const out = fitHistory([reply("orphan"), ...chat(4)], 10_000);
    expect(out.messages[0]).toMatchObject({ role: "user" });
    expect(textOf(out.messages)).not.toContain("orphan");
  });

  it("shortens long tool results in older turns and keeps recent ones whole", () => {
    const big = { image_url: "https://cdn/0.png", details: "z".repeat(1_000) };
    const h = [...toolTurn(0, big), ...chat(3)];
    const [old] = fitHistory(h, 100_000).messages.filter((m) => m.role === "tool") as { content: string }[];
    expect(JSON.parse(old!.content)).toMatchObject({ status: "completed", files: ["img_10"] });
    const recent = fitHistory(toolTurn(0, big), 100_000).messages.find((m) => m.role === "tool") as { content: string };
    expect(recent.content).toContain("zzz");
  });

  it("caps a huge tool result", () => {
    const [, , tool] = toLlmMessages(toolTurn(0, { text: "z".repeat(50_000) })) as { content: string }[];
    expect(tool!.content.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 20);
    expect(tool!.content).toMatch(/\[trimmed\]$/);
  });
});

describe("planSummary", () => {
  const limits = { limitTokens: 16_000, limitMessages: 40, keepMessages: 10, targetTokens: 6_000 };

  it("40 small messages: keeps the newest 10 and folds 30", () => {
    const { fold, keep } = planSummary(chat(20), { keepMessages: 10, keepTokens: keepTokens(limits) });
    expect([fold.length, keep.length]).toEqual([30, 10]);
    expect(keep[0]).toMatchObject({ role: "user" });
  });

  it("big messages: keeps fewer than 10, but never fewer than 3 turns", () => {
    const { keep } = planSummary(chat(20, 1_500), { keepMessages: 10, keepTokens: keepTokens(limits) });
    expect(keep).toHaveLength(6);
  });

  it("a short chat folds nothing", () => {
    expect(planSummary(chat(3), { keepMessages: 10, keepTokens: 4_500 }).fold).toEqual([]);
  });

  it("starts at 16,000 prompt tokens or 40 messages, whichever comes first", () => {
    expect(needsSummary({ lastPromptTokens: 17_000, messagesSinceSummary: 5 }, limits)).toBe(true);
    expect(needsSummary({ lastPromptTokens: 2_000, messagesSinceSummary: 41 }, limits)).toBe(true);
    expect(needsSummary({ lastPromptTokens: 16_000, messagesSinceSummary: 40 }, limits)).toBe(false);
  });

  it("never keeps a summary that was cut off or empty", () => {
    expect(acceptSummary({ text: " The user asked for a fox. ", finishReason: "stop" })).toBe("The user asked for a fox.");
    expect(acceptSummary({ text: "The user began by saying hi. The user then asked", finishReason: "length" })).toBeNull();
    expect(acceptSummary({ text: "  ", finishReason: "stop" })).toBeNull();
  });

  it("asks for a summary that builds on the previous one and keeps file names", () => {
    const [system, req] = summaryMessages("User made a fox (img_2).", toolTurn(0, { image_url: "https://cdn/0.png" }));
    expect(system!.role).toBe("system");
    expect(req!.content).toContain("Summary so far:\nUser made a fox (img_2).");
    expect(req!.content).toContain("User: crop 0");
    expect(req!.content).toContain("Assistant called crop_image");
    expect(req!.content).toContain("img_10");
  });
});

describe("chat files", () => {
  const known: KnownFile[] = [
    { ref: "img_1", kind: "image", url: "https://cdn/tiger.png", name: "tiger.png" },
    { ref: "vid_2", kind: "video", url: "https://cdn/v.mp4", tool: "merge_videos", durationSec: 21.4 },
    { ref: "img_12", kind: "image", url: "https://cdn/12.png", tool: "crop_image" },
  ];

  it("resolves names recorded in Postgres even when their message was trimmed", () => {
    const ctx = fileContext([], known);
    expect(ctx.files.get("img_1")).toBe("https://cdn/tiger.png");
    expect(ctx.aliases.get("tiger.png")).toBe("img_1");
    expect(ctx.durations.get("https://cdn/v.mp4")).toBe(21.4);
  });

  it("lists only files the sent history no longer shows", () => {
    expect(olderFileLines(known, 'Attached image img_12: "x"')).toEqual([
      '- img_1 (image, uploaded "tiger.png")',
      "- vid_2 (video, 21s, made by merge_videos)",
    ]);
  });

  it("puts stable text first: base, skills, summary, older files, plan mode last", () => {
    const p = systemPrompt(["- a: b"], true, { summary: "S", olderFiles: ["- img_1 (image)"] });
    const at = (s: string) => p.indexOf(s);
    expect(at("Skills:")).toBeLessThan(at("Summary of the earlier conversation"));
    expect(at("Summary of the earlier conversation")).toBeLessThan(at("- img_1 (image)"));
    expect(at("- img_1 (image)")).toBeLessThan(at("PLAN MODE"));
  });

  it("the loop sends the summary, older files and a trimmed history", async () => {
    const seen: LlmMessage[][] = [];
    const llm: LlmProvider = {
      async streamStep(req) {
        seen.push(req.messages);
        return { text: "ok", thinking: "", toolCalls: [], model: "m", usage: { promptTokens: 1, completionTokens: 1 }, finishReason: "stop" } satisfies StepResult;
      },
    };
    const blocks: ContentBlock[][] = [];
    await runAgentTurn({
      llm,
      toolSpecs: [],
      maxSteps: 2,
      historyTokens: 60,
      tools: {} as never,
      history: async () => ({ messages: chat(10), summary: "Earlier: a tiger (img_1).", files: known }),
      emit: () => {},
      meta: () => {},
      checkpoint: async (b) => void blocks.push(b),
    });
    const [system, ...rest] = seen[0]!;
    expect(system!.content).toContain("Earlier: a tiger (img_1).");
    expect(system!.content).toContain('- img_1 (image, uploaded "tiger.png")');
    expect(rest.length).toBeLessThan(20);
    expect(rest[0]).toMatchObject({ role: "user" });
  });
});
