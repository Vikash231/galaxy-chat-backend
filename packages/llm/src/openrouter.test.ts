import { describe, expect, it, vi } from "vitest";
import { createOpenRouterProvider } from "./openrouter";
import { LlmError, type LlmDelta } from "./types";

type Chunk = Record<string, unknown>;
const stream = (chunks: Chunk[]) => ({ async *[Symbol.asyncIterator]() { yield* chunks; } });
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const text = (d: string, model = "meta/llama:free"): Chunk => ({ model, choices: [{ delta: { content: d } }] });

function provider(responses: (Chunk[] | Error)[]) {
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return stream(next);
  });
  const p = createOpenRouterProvider({ apiKey: "k", baseURL: "https://x", model: "openrouter/free", backoffMs: [0, 0, 0], client: { chat: { completions: { create } } } as never });
  return { p, create };
}

const req = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };

describe("openrouter provider", () => {
  it("streams text, records the routed model and usage", async () => {
    const { p } = provider([[text("Hel"), text("lo"), { model: "meta/llama:free", choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }]]);
    const deltas: LlmDelta[] = [];
    const res = await p.streamStep(req, (d) => deltas.push(d));
    expect(res).toMatchObject({ text: "Hello", model: "meta/llama:free", usage: { promptTokens: 7, completionTokens: 2 } });
    expect(deltas.map((d) => d.delta).join("")).toBe("Hello");
  });

  it("assembles tool calls streamed in fragments", async () => {
    const tc = (index: number, f: object, id?: string) => ({ choices: [{ delta: { tool_calls: [{ index, ...(id && { id }), function: f }] } }] });
    const { p } = provider([[tc(0, { name: "crop_", arguments: '{"a":' }, "call_x"), tc(0, { name: "image", arguments: "1}" }), tc(1, { name: "crop_image", arguments: "{}" })]]);
    const res = await p.streamStep(req, () => {});
    expect(res.toolCalls).toEqual([
      { id: "call_x", name: "crop_image", argsJson: '{"a":1}' },
      { id: "call_1", name: "crop_image", argsJson: "{}" },
    ]);
  });

  it("retries 429 before anything was streamed", async () => {
    const { p, create } = provider([httpError(429), httpError(503), [text("ok")]]);
    await expect(p.streamStep(req, () => {})).resolves.toMatchObject({ text: "ok" });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("gives a clear terminal error when free models stay unavailable", async () => {
    const { p } = provider([httpError(429), httpError(429), httpError(429), httpError(429)]);
    const err = await p.streamStep(req, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: "llm_unavailable" });
  });

  it("retries an empty response once, then fails", async () => {
    expect(await provider([[], [text("ok")]]).p.streamStep(req, () => {})).toMatchObject({ text: "ok" });
    await expect(provider([[], []]).p.streamStep(req, () => {})).rejects.toMatchObject({ code: "llm_empty_response" });
  });

  it("does not retry after text was shown, so the user never sees it twice", async () => {
    const broken = { async *[Symbol.asyncIterator]() { yield text("partial"); throw httpError(502); } };
    const create = vi.fn().mockResolvedValueOnce(broken).mockResolvedValueOnce(stream([text("again")]));
    const p = createOpenRouterProvider({ apiKey: "k", baseURL: "https://x", model: "openrouter/free", backoffMs: [0], client: { chat: { completions: { create } } } as never });
    await expect(p.streamStep(req, () => {})).rejects.toMatchObject({ code: "llm_error" });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
