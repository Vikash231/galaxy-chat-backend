import type { ContentBlock, RunMeta, SafeError, StreamPart } from "@gx/contracts";
import type { LlmMessage, LlmProvider, LlmToolSpec, StepResult } from "@gx/llm";
import { executeTools, type ExecutedCall, type PendingCall, type ToolPorts } from "./executor";
import { collectFiles } from "./files";
import { toLlmMessages, type StoredMessage } from "./history";
import { llmCallId, toolCallKey } from "./ids";

export const SYSTEM_PROMPT = [
  "You are Galaxy, an assistant that can edit and create media with tools.",
  "Call a tool when the user asks for a media operation; otherwise answer directly.",
  'Every file in the chat has a short name like img_1. Pass that name to tools (e.g. image: "img_1"); never copy or invent URLs.',
  "If the user asks to edit an image but none is attached, ask them to attach one.",
  "To create a new image, call gpt_image_2 with only a prompt; to change an existing image, also pass its name in images.",
  "In replies, describe files by what they show; never mention their names like img_1 to the user.",
  "After a tool succeeds, reply in one or two sentences; the app displays the resulting file.",
].join(" ");

export interface TurnPorts {
  llm: LlmProvider;
  toolSpecs: LlmToolSpec[];
  tools: ToolPorts;
  maxSteps: number;
  signal?: AbortSignal;
  history(): Promise<StoredMessage[]>;
  emit(part: StreamPart): void;
  meta(patch: Partial<Pick<RunMeta, "status" | "step" | "label">>): void;
  /** Persist all blocks produced so far; called at step boundaries only. */
  checkpoint(blocks: ContentBlock[], step: number, llm?: StepResult): Promise<void>;
}

export type TurnOutcome = { status: "completed" | "failed"; blocks: ContentBlock[]; error?: SafeError };

export async function runAgentTurn(p: TurnPorts): Promise<TurnOutcome> {
  const blocks: ContentBlock[] = [];
  const history = await p.history();
  const files = collectFiles(history);
  const usage = { type: "usage" as const, creditsMicro: 0, promptTokens: 0, completionTokens: 0, models: [] as string[] };
  const finish = (o: Omit<TurnOutcome, "blocks">): TurnOutcome => ({ ...o, blocks: [...blocks, usage] });
  const messages: LlmMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...toLlmMessages(history)];

  for (let step = 0; step < p.maxSteps; step++) {
    p.meta({ status: "thinking", step, label: undefined });
    const res = await p.llm.streamStep({ messages, tools: p.toolSpecs, signal: p.signal }, (d) => p.emit({ t: d.type, step, d: d.delta }));
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    if (!usage.models.includes(res.model)) usage.models.push(res.model);

    const calls: PendingCall[] = res.toolCalls.map((c, i) => ({ key: toolCallKey(step, c.id), seq: step * 100 + i, name: c.name, argsJson: c.argsJson }));
    if (res.thinking) blocks.push({ type: "thinking", text: res.thinking });
    if (res.text) blocks.push({ type: "text", text: res.text });
    for (const c of calls) blocks.push({ type: "tool_use", toolCallId: c.key, name: c.name, input: safeJson(c.argsJson) });
    await p.checkpoint(blocks, step, res);
    if (!calls.length) return finish({ status: "completed" });

    p.meta({ status: "working", step });
    const results: ExecutedCall[] = await executeTools(p.tools, calls, files);
    messages.push({
      role: "assistant",
      content: res.text || null,
      tool_calls: calls.map((c) => ({ id: llmCallId(c.key), type: "function", function: { name: c.name, arguments: c.argsJson || "{}" } })),
    });
    for (const r of results) {
      usage.creditsMicro += Number(r.creditsMicro);
      blocks.push(...r.blocks);
      messages.push({ role: "tool", tool_call_id: llmCallId(r.key), content: r.llmContent });
    }
    await p.checkpoint(blocks, step);
    const stop = results.find((r) => r.stop)?.stop;
    if (stop) return finish({ status: "failed", error: stop });
  }

  blocks.push({ type: "text", text: "I stopped here because this reply reached its step limit. Send a follow-up to continue." });
  return finish({ status: "completed" });
}

function safeJson(s: string): unknown {
  try {
    return s.trim() ? JSON.parse(s) : {};
  } catch {
    return { raw: s };
  }
}
