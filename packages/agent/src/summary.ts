import type { LlmMessage } from "@gx/llm";
import { KEEP_TURNS, sizeOf, toLlmMessages, toTurns, type StoredMessage } from "./history";

/** Output cap for the summariser. Reasoning models spend part of it thinking, so it is well above the 250-word ask. */
export const SUMMARY_MAX_TOKENS = 2_000;

/** The summary to save, or null when it is empty or was cut off by the length cap (saving half a summary loses facts). */
export const acceptSummary = (res: { text: string; finishReason: string | null }) => {
  const text = res.text.trim();
  return text && res.finishReason !== "length" ? text : null;
};

export type SummaryLimits = { limitTokens: number; limitMessages: number; keepMessages: number; targetTokens: number };

/** Whether to fold older messages into a summary after a reply: the prompt got big, or many messages piled up. */
export const needsSummary = (s: { lastPromptTokens: number; messagesSinceSummary: number }, l: SummaryLimits) =>
  s.lastPromptTokens > l.limitTokens || s.messagesSinceSummary > l.limitMessages;

/** Room left for kept messages once the system prompt (~1,000) and the summary itself are counted. */
export const keepTokens = (l: SummaryLimits) => Math.max(0, l.targetTokens - 1_000 - SUMMARY_MAX_TOKENS);

/**
 * Which messages a summary should fold in: keep the newest turns (up to `keepMessages` messages and
 * `keepTokens` tokens, but never fewer than KEEP_TURNS turns) and fold everything older.
 */
export function planSummary(history: StoredMessage[], opts: { keepMessages: number; keepTokens: number }) {
  const turns = toTurns(history);
  let kept = 0;
  let messages = 0;
  let tokens = 0;
  while (kept < turns.length) {
    const t = turns[turns.length - 1 - kept]!;
    const size = toLlmMessages(t).reduce((n, m) => n + sizeOf(m), 0);
    const fits = messages + t.length <= opts.keepMessages && tokens + size <= opts.keepTokens;
    if (!fits && kept >= KEEP_TURNS) break;
    messages += t.length;
    tokens += size;
    kept++;
  }
  const cut = turns.length - kept;
  return { fold: turns.slice(0, cut).flat(), keep: turns.slice(cut).flat() };
}

/** Plain-text transcript for the summariser; long results are already shortened. */
export function transcript(history: StoredMessage[]): string {
  return toLlmMessages(history, true)
    .map((m) => {
      if (m.role === "user") return `User: ${m.content}`;
      if (m.role === "tool") return `Tool result: ${m.content}`;
      if (m.role === "assistant") {
        const calls = (m.tool_calls ?? []).map((c) => `Assistant called ${c.function.name} ${c.function.arguments}`);
        return [m.content ? `Assistant: ${m.content}` : "", ...calls].filter(Boolean).join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .map((line) => (line.length > 2_000 ? `${line.slice(0, 2_000)}…` : line))
    .join("\n");
}

/** The summariser's request: the previous summary (if any) plus the messages to fold in. */
export function summaryMessages(previous: string | null | undefined, fold: StoredMessage[]): LlmMessage[] {
  return [
    {
      role: "system",
      content:
        "You keep a running summary of a chat between a user and Galaxy, an assistant that creates and edits images and videos with tools. " +
        "Write at most 250 words of plain sentences, no headings. Keep: what the user asked for, what was made or changed and each file's name " +
        "(like img_3) with what it shows, the user's stated preferences, and anything still pending. Never invent details.",
    },
    { role: "user", content: `${previous ? `Summary so far:\n${previous}\n\n` : ""}Messages to add:\n${transcript(fold)}` },
  ];
}
