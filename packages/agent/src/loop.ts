import type { ContentBlock, RunMeta, SafeError, StreamPart } from "@gx/contracts";
import type { LlmMessage, LlmProvider, LlmToolSpec, StepResult } from "@gx/llm";
import { executeTools, type ExecutedCall, type PendingCall, type ToolPorts } from "./executor";
import { fileContext, hideFileNames, olderFileLines, type KnownFile } from "./files";
import { fitHistory, type StoredMessage } from "./history";
import { llmCallId, toolCallKey } from "./ids";

const BASE_PROMPT = [
  "You are Galaxy, an assistant that can edit and create media with tools.",
  "Call a tool when the user asks for a media operation; otherwise answer directly.",
  'Every file in the chat has a short name like img_1. Pass that name to tools (e.g. image: "img_1"); never copy or invent URLs.',
  "If the user asks to edit an image but none is attached, ask them to attach one.",
  "To create a new image, call gpt_image_2 with only a prompt; to change an existing image, also pass its name in images.",
  "To join videos end to end, call merge_videos with their names in the order the user wants.",
  "If the user's wording about order, or about which file is which, is unclear and a wrong guess would cost credits, call ask_user with the choices (or the files) instead of guessing. Never ask which file in plain text: you cannot name files to the user, so always call ask_user with files so they can pick from previews.",
  'After merging, say the final order in plain words, e.g. "the 6-second clip, then the 15-second clip".',
  "In replies, describe files by what they show; never mention their names like img_1 to the user.",
  "After a tool succeeds, reply in one or two sentences; the app displays the resulting file.",
].join(" ");

const PLAN_MODE_PROMPT =
  "PLAN MODE is on. A request that needs no paid tool (a greeting, a question) gets a direct reply with no plan. Before any tool that costs credits, call propose_plan with a short summary and the steps; give tool and args (as JSON) for every step that uses a tool, so the cost can be shown. Paid tools are blocked until the user approves. After approval, carry out the plan. If the approval includes a note from the user, the note is part of the plan: apply it to the tool arguments (for example, add it to the prompt) before calling the tool.";

/**
 * Base instructions, the skills list (names and descriptions only), then what changes more often: the summary of
 * older messages, files the sent history no longer shows, and the plan-mode rule. Stable text first lets a
 * provider reuse its cached prefix.
 */
export function systemPrompt(skills: string[] = [], planMode = false, extra: { summary?: string | null; olderFiles?: string[] } = {}): string {
  const parts = [BASE_PROMPT];
  if (skills.length)
    parts.push(
      "Skills are free guides for specific kinds of work. When a request matches one, call load_skill before acting, then follow it; read its extra files with read_skill_asset only when the guide asks.",
      "Skills:",
      ...skills,
    );
  if (extra.summary) parts.push(`Summary of the earlier conversation (those messages are not shown):\n${extra.summary}`);
  if (extra.olderFiles?.length) parts.push("Files from earlier in this chat (use these names with tools):", ...extra.olderFiles);
  if (planMode) parts.push(PLAN_MODE_PROMPT);
  return parts.join("\n");
}

/** What the model sees of the chat: a summary of older messages, the messages after it, and the chat's files. */
export type ChatContext = { messages: StoredMessage[]; summary?: string | null; files?: KnownFile[] };

export interface TurnPorts {
  llm: LlmProvider;
  toolSpecs: LlmToolSpec[];
  tools: ToolPorts;
  maxSteps: number;
  /** Skills list lines for the system prompt (see systemPrompt). */
  skills?: string[];
  /** Plan mode: the system prompt asks for a plan first (the executor enforces it). */
  planMode?: boolean;
  /** Set on a retry: one line for the model (not saved) saying the last try stopped and what not to repeat. */
  retryNote?: string;
  /** Token budget for the sent history (estimated); the newest turns are always sent. */
  historyTokens?: number;
  signal?: AbortSignal;
  history(): Promise<ChatContext>;
  emit(part: StreamPart): void;
  meta(patch: Partial<Pick<RunMeta, "status" | "step" | "label">>): void;
  /** Persist all blocks produced so far; called at step boundaries only. */
  checkpoint(blocks: ContentBlock[], step: number, llm?: StepResult): Promise<void>;
}

export type TurnOutcome = { status: "completed" | "failed"; blocks: ContentBlock[]; error?: SafeError };

export async function runAgentTurn(p: TurnPorts): Promise<TurnOutcome> {
  const blocks: ContentBlock[] = [];
  const chat = await p.history();
  const fileCtx = fileContext(chat.messages, chat.files);
  const history = fitHistory(chat.messages, p.historyTokens ?? Number.POSITIVE_INFINITY);
  const usage = { type: "usage" as const, creditsMicro: 0, promptTokens: 0, completionTokens: 0, models: [] as string[] };
  const finish = (o: Omit<TurnOutcome, "blocks">): TurnOutcome => ({ ...o, blocks: [...blocks, usage] });
  const olderFiles = olderFileLines(chat.files ?? [], JSON.stringify(history.messages));
  const system = systemPrompt(p.skills, p.planMode, { summary: chat.summary, olderFiles });
  const messages: LlmMessage[] = [{ role: "system", content: system }, ...history.messages];
  if (p.retryNote) messages.push({ role: "user", content: p.retryNote });

  for (let step = 0; step < p.maxSteps; step++) {
    p.meta({ status: "thinking", step, label: undefined });
    const partial = { text: "", thinking: "" };
    let res: StepResult;
    try {
      res = await p.llm.streamStep({ messages, tools: p.toolSpecs, signal: p.signal }, (d) => {
        partial[d.type] += d.delta;
        p.emit({ t: d.type, step, d: d.delta });
      });
    } catch (e) {
      // Stopped or failed mid-step: keep what the user already saw stream in, then let the caller finalize.
      await keepPartial(blocks, partial, step, p);
      throw e;
    }
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    if (!usage.models.includes(res.model)) usage.models.push(res.model);

    const calls: PendingCall[] = res.toolCalls.map((c, i) => ({ key: toolCallKey(step, c.id), seq: step * 100 + i, name: c.name, argsJson: c.argsJson }));
    if (res.thinking) blocks.push({ type: "thinking", text: res.thinking });
    const text = hideFileNames(res.text);
    if (text) blocks.push({ type: "text", text });
    for (const c of calls) blocks.push({ type: "tool_use", toolCallId: c.key, name: c.name, input: safeJson(c.argsJson) });
    await p.checkpoint(blocks, step, res);
    if (!calls.length) return finish({ status: "completed" });

    p.meta({ status: "working", step });
    const results: ExecutedCall[] = await executeTools(p.tools, calls, fileCtx);
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
    // The user declined or never answered: finish normally with a note, without another model call.
    const end = results.find((r) => r.end)?.end;
    if (end) {
      blocks.push({ type: "text", text: end });
      await p.checkpoint(blocks, step);
      return finish({ status: "completed" });
    }
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

/** Save the thinking and text streamed before an interrupted step; a failed save must not hide the real error. */
async function keepPartial(blocks: ContentBlock[], partial: { text: string; thinking: string }, step: number, p: TurnPorts) {
  const text = hideFileNames(partial.text);
  if (partial.thinking.trim()) blocks.push({ type: "thinking", text: partial.thinking });
  if (text) blocks.push({ type: "text", text });
  if (partial.thinking.trim() || text) await p.checkpoint(blocks, step).catch(() => {});
}
