import type { ContentBlock } from "@gx/contracts";
import type { LlmMessage } from "@gx/llm";
import { refOf, withRefs } from "./files";
import { llmCallId } from "./ids";

export type StoredMessage = { id?: string; createdAt?: Date; role: "user" | "assistant" | "system" | "tool"; content: ContentBlock[] };

/** The newest turns always sent word for word; older tool results may be shortened. */
export const KEEP_TURNS = 3;
/** Longest tool result the model is sent (about 2,000 tokens). */
export const TOOL_RESULT_MAX_CHARS = 8_000;
/** Older tool results longer than this are cut down to their status and files. */
const COMPACT_OVER_CHARS = 300;

/** Rough token count: about 4 characters per token. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export const sizeOf = (m: LlmMessage) =>
  estimateTokens((m.content ?? "") + ("tool_calls" in m && m.tool_calls ? JSON.stringify(m.tool_calls) : ""));

export const capToolContent = (s: string) => (s.length > TOOL_RESULT_MAX_CHARS ? `${s.slice(0, TOOL_RESULT_MAX_CHARS)}…[trimmed]` : s);

const textOf = (blocks: ContentBlock[]) =>
  blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();

/** Uploaded files reach the model by name only; tools turn the name back into the URL. */
const attachmentLines = (blocks: ContentBlock[]) =>
  blocks
    .flatMap((b) => {
      if (b.type !== "attachment") return [];
      const facts = [b.width && b.height ? `${b.width}x${b.height}` : "", b.durationSec != null ? `${Math.round(b.durationSec)}s` : ""].filter(Boolean).join(", ");
      return [`Attached ${b.kind} ${refOf(b)}: "${b.name}"${facts ? ` (${facts})` : ""}`];
    })
    .join("\n");

/** A tool result as the model sees it: file URLs in the output are replaced by the files' names. */
export const toolResultContent = (b: Extract<ContentBlock, { type: "tool_result" }>, urlToRef: ReadonlyMap<string, string> = new Map(), compact = false) => {
  const full = JSON.stringify(b.status === "completed" ? withRefs(b.output ?? {}, urlToRef) : { error: b.error?.message ?? b.status });
  if (!compact || full.length <= COMPACT_OVER_CHARS || b.status !== "completed") return capToolContent(full);
  const files = [...urlToRef.values()].filter((ref) => full.includes(`"${ref}"`));
  return JSON.stringify({ status: "completed", ...(files.length && { files }), note: "Details trimmed from this older step." });
};

/**
 * Rebuild the provider message list from stored blocks. `compact` shortens long tool results (older turns).
 * Tool calls without a stored result (an interrupted turn) are dropped; providers reject dangling calls.
 */
export function toLlmMessages(history: StoredMessage[], compact = false): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of history) {
    if (m.role === "user") {
      const text = [attachmentLines(m.content), textOf(m.content)].filter(Boolean).join("\n\n");
      if (text) out.push({ role: "user", content: text });
      continue;
    }
    if (m.role !== "assistant") continue;
    const results = new Map(m.content.flatMap((b) => (b.type === "tool_result" ? [[b.toolCallId, b] as const] : [])));
    const urlToRef = new Map(m.content.flatMap((b) => (b.type === "asset" ? [[b.url, refOf(b)] as const] : [])));
    let text = "";
    let calls: { key: string; name: string; input: unknown }[] = [];
    const flush = () => {
      const answered = calls.filter((c) => results.has(c.key));
      if (!text.trim() && !answered.length) return;
      out.push({
        role: "assistant",
        content: text.trim() || null,
        ...(answered.length && {
          tool_calls: answered.map((c) => ({ id: llmCallId(c.key), type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })),
        }),
      });
      for (const c of answered) out.push({ role: "tool", tool_call_id: llmCallId(c.key), content: toolResultContent(results.get(c.key)!, urlToRef, compact) });
      text = "";
      calls = [];
    };
    for (const b of m.content) {
      if (b.type === "text") {
        if (calls.length) flush();
        text += (text ? "\n" : "") + b.text;
      } else if (b.type === "tool_use") {
        calls.push({ key: b.toolCallId, name: b.name, input: b.input });
      }
    }
    flush();
  }
  return out;
}

/** Group messages into turns; a turn starts at a user message (a leading reply without its question is its own group). */
export function toTurns(history: StoredMessage[]): StoredMessage[][] {
  const turns: StoredMessage[][] = [];
  for (const m of history) {
    if (m.role === "user" || !turns.length) turns.push([m]);
    else turns.at(-1)!.push(m);
  }
  return turns;
}

const startsWithUser = (turn: StoredMessage[]) => turn[0]?.role === "user";

/**
 * The history to send, newest turns first until `budgetTokens` is used. The last KEEP_TURNS turns are always
 * sent; older turns get short tool results; the kept part always starts at a user message.
 */
export function fitHistory(history: StoredMessage[], budgetTokens: number) {
  const turns = toTurns(history).map((t, i, all) => {
    const messages = toLlmMessages(t, i < all.length - KEEP_TURNS);
    return { turn: t, messages, tokens: messages.reduce((n, m) => n + sizeOf(m), 0) };
  });
  let tokens = 0;
  let first = turns.length;
  while (first > 0) {
    const t = turns[first - 1]!;
    const recent = turns.length - first < KEEP_TURNS;
    if (!recent && tokens + t.tokens > budgetTokens) break;
    tokens += t.tokens;
    first--;
  }
  // Never open on a reply whose question was cut.
  while (first < turns.length - 1 && !startsWithUser(turns[first]!.turn)) tokens -= turns[first++]!.tokens;
  const kept = turns.slice(first);
  return { messages: kept.flatMap((t) => t.messages), tokens, dropped: turns.slice(0, first).reduce((n, t) => n + t.turn.length, 0) };
}
