import { createHash } from "node:crypto";
import type { ContentBlock } from "@gx/contracts";

type FileBlock = Extract<ContentBlock, { type: "attachment" | "asset" }>;
const PREFIX = { image: "img", video: "vid", audio: "aud" } as const;

/** A file's short name: the one saved with it, or (for files saved before names existed) a stable hash of its URL. */
export const refOf = (b: FileBlock) => b.ref ?? `${PREFIX[b.kind]}_${createHash("sha1").update(b.url).digest("hex").slice(0, 6)}`;

/** Every file named in the loaded history, so tools can turn a name back into its URL. */
export function collectFiles(history: { content: ContentBlock[] }[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const m of history) for (const b of m.content) if (b.type === "attachment" || b.type === "asset") files.set(refOf(b), b.url);
  return files;
}

/** Replace file URLs inside a tool output with their names, so the model never has to copy a URL. */
export function withRefs(value: unknown, urlToRef: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return urlToRef.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => withRefs(v, urlToRef));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withRefs(v, urlToRef)]));
  return value;
}
