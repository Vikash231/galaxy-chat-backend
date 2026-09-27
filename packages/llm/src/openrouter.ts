import OpenAI from "openai";
import { LlmError, type LlmDelta, type LlmProvider, type StepRequest, type StepResult } from "./types";

export type OpenRouterOptions = {
  apiKey: string;
  baseURL: string;
  model: string;
  /** Default reply length cap for every call. */
  maxTokens?: number;
  backoffMs?: number[];
  client?: Pick<OpenAI, "chat">;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export function createOpenRouterProvider(opts: OpenRouterOptions): LlmProvider {
  const client =
    opts.client ??
    new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0, timeout: 120_000, defaultHeaders: { "X-Title": "Galaxy Agent Chat" } });
  const backoff = opts.backoffMs ?? [1_000, 3_000, 9_000];

  async function attempt(req: StepRequest, onDelta: (d: LlmDelta) => void, emitted: { any: boolean }): Promise<StepResult> {
    const stream = await client.chat.completions.create(
      {
        model: opts.model,
        messages: req.messages as OpenAI.ChatCompletionMessageParam[],
        ...(req.tools.length && { tools: req.tools }),
        ...((req.maxTokens ?? opts.maxTokens) && { max_tokens: req.maxTokens ?? opts.maxTokens }),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: req.signal },
    );
    const out: StepResult = { text: "", thinking: "", toolCalls: [], model: opts.model, usage: { promptTokens: 0, completionTokens: 0 }, finishReason: null };
    const calls: { id?: string; name: string; args: string }[] = [];

    for await (const chunk of stream) {
      const err = (chunk as { error?: { message?: string; code?: number } }).error;
      if (err) throw Object.assign(new Error(err.message ?? "provider error"), { status: err.code });
      if (chunk.model) out.model = chunk.model;
      if (chunk.usage) out.usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta as typeof choice.delta & { reasoning?: string | null };
      if (delta.reasoning) (out.thinking += delta.reasoning), (emitted.any = true), onDelta({ type: "thinking", delta: delta.reasoning });
      if (delta.content) (out.text += delta.content), (emitted.any = true), onDelta({ type: "text", delta: delta.content });
      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { name: "", args: "" });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (choice.finish_reason) out.finishReason = choice.finish_reason;
    }
    // Some free models omit tool-call ids; synthesize stable ones so results can be matched.
    out.toolCalls = calls.filter(Boolean).map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.name, argsJson: c.args }));
    return out;
  }

  return {
    async streamStep(req, onDelta) {
      const emitted = { any: false };
      let emptyRetried = false;
      for (let i = 0; ; i++) {
        try {
          const res = await attempt(req, onDelta, emitted);
          if (!res.text && !res.toolCalls.length) {
            if (emptyRetried) throw new LlmError("llm_empty_response", "The model returned an empty response.", true);
            emptyRetried = true;
            continue;
          }
          return res;
        } catch (e) {
          if (e instanceof LlmError || req.signal?.aborted) throw e;
          const status = (e as { status?: number }).status;
          // Retrying after text was streamed would duplicate it on screen, so only retry clean failures.
          if (status && RETRYABLE_STATUS.has(status) && !emitted.any && i < backoff.length) {
            await sleep(backoff[i]!, req.signal);
            continue;
          }
          if (status === 400 && /context|too long|maximum.*tokens/i.test((e as Error).message ?? ""))
            throw new LlmError("llm_context_too_long", "This chat is too long for the model. Start a new chat.", false);
          if (status === 429 || status === 503)
            throw new LlmError("llm_unavailable", "Free models are busy right now. Try again in a minute.", true);
          throw new LlmError("llm_error", "The model request failed.", true);
        }
      }
    },
  };
}
