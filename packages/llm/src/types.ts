import type { SafeError } from "@gx/contracts";

export type LlmToolCall = { id: string; name: string; argsJson: string };

export type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type LlmToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type LlmDelta = { type: "text" | "thinking"; delta: string };

export type StepResult = {
  text: string;
  thinking: string;
  toolCalls: LlmToolCall[];
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string | null;
};

export type StepRequest = { messages: LlmMessage[]; tools: LlmToolSpec[]; signal?: AbortSignal };

/** Provider-neutral contract the agent loop depends on. */
export interface LlmProvider {
  streamStep(req: StepRequest, onDelta: (d: LlmDelta) => void): Promise<StepResult>;
}

export class LlmError extends Error {
  constructor(
    readonly code: "llm_unavailable" | "llm_empty_response" | "llm_error",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
  toSafe(): SafeError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
