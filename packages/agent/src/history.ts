import type { ContentBlock } from "@gx/contracts";
import type { LlmMessage } from "@gx/llm";
import { refOf, withRefs } from "./files";
import { llmCallId } from "./ids";

export type StoredMessage = { role: "user" | "assistant" | "system" | "tool"; content: ContentBlock[] };

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
export const toolResultContent = (b: Extract<ContentBlock, { type: "tool_result" }>, urlToRef: ReadonlyMap<string, string> = new Map()) =>
  JSON.stringify(b.status === "completed" ? withRefs(b.output ?? {}, urlToRef) : { error: b.error?.message ?? b.status });

/**
 * Rebuild the provider message list from stored blocks.
 * Tool calls without a stored result (an interrupted turn) are dropped; providers reject dangling calls.
 */
export function toLlmMessages(history: StoredMessage[]): LlmMessage[] {
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
      for (const c of answered) out.push({ role: "tool", tool_call_id: llmCallId(c.key), content: toolResultContent(results.get(c.key)!, urlToRef) });
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
