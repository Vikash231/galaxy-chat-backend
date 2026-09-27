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

/** Uploaded file name → short name, for names that match exactly one upload in the chat. */
export function collectAliases(history: { content: ContentBlock[] }[]): Map<string, string> {
  return aliasesOf(history.flatMap((m) => m.content.flatMap((b) => (b.type === "attachment" ? [[b.name, refOf(b)] as const] : []))));
}

const aliasesOf = (pairs: (readonly [string, string])[]) => {
  const seen = new Map<string, string | null>();
  for (const [name, ref] of pairs) seen.set(name, seen.has(name) && seen.get(name) !== ref ? null : ref);
  return new Map([...seen].filter((e): e is [string, string] => e[1] !== null));
};

/** Known lengths of video/audio files, by URL; duration-billed tools estimate from these. */
export function collectDurations(history: { content: ContentBlock[] }[]): Map<string, number> {
  const durations = new Map<string, number>();
  for (const m of history) for (const b of m.content) if ((b.type === "attachment" || b.type === "asset") && b.durationSec != null) durations.set(b.url, b.durationSec);
  return durations;
}

const SPOKEN = { img: "the image", vid: "the video", aud: "the audio" } as const;

/**
 * Keep internal file names and invented media markup out of reply text; the app already shows the files.
 * Models are told this in the prompt, but small free models ignore it.
 */
export function hideFileNames(text: string): string {
  return text
    // Weak models sometimes print tool-call markup as text; the real calls arrive separately.
    .replace(/<tool_call>[\s\S]*?<\/tool_call>|<\/?tool_call>/gi, "")
    .replace(/<(video|audio|img)\b[^>]*>[\s\S]*?<\/\1>|<(video|audio|img)\b[^>]*\/?>/gi, "")
    .replace(/!?\[[^\]]*\]\(\s*(?:img|vid|aud)_[a-z0-9]+\s*\)/g, "")
    .replace(/\s*\((?:img|vid|aud)_[a-z0-9]+\)/g, "")
    // Standalone names only: never inside a URL or filename like example.com/img_1.png.
    .replace(/[`"']?(?<![\w/.-])(img|vid|aud)_[a-z0-9]+(?![\w-]|\.\w)[`"']?/g, (_m, kind: keyof typeof SPOKEN) => SPOKEN[kind])
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Replace file URLs inside a tool output with their names, so the model never has to copy a URL. */
export function withRefs(value: unknown, urlToRef: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return urlToRef.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => withRefs(v, urlToRef));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withRefs(v, urlToRef)]));
  return value;
}

/** A named file of the chat, as recorded in Postgres (upload or tool result). */
export type KnownFile = { ref: string; kind: "image" | "video" | "audio"; url: string; name?: string | null; tool?: string | null; durationSec?: number | null };

/** Every file the tools may use: the chat's recorded files plus any named in the loaded history. */
export function fileContext(history: { content: ContentBlock[] }[], known: KnownFile[] = []) {
  const files = collectFiles(history);
  const durations = collectDurations(history);
  for (const f of known) {
    files.set(f.ref, f.url);
    if (f.durationSec != null) durations.set(f.url, f.durationSec);
  }
  const pairs = [
    ...known.flatMap((f) => (f.name ? [[f.name, f.ref] as const] : [])),
    ...history.flatMap((m) => m.content.flatMap((b) => (b.type === "attachment" ? [[b.name, refOf(b)] as const] : []))),
  ];
  return { files, aliases: aliasesOf(pairs), durations };
}

const MAX_LISTED_FILES = 50;

/** Lines naming files the sent history no longer shows (trimmed or summarised), newest last. */
export function olderFileLines(known: KnownFile[], sentText: string): string[] {
  return known
    .filter((f) => !new RegExp(`(?<![\\w])${f.ref}(?![\\w])`).test(sentText))
    .slice(-MAX_LISTED_FILES)
    .map((f) => {
      const facts = [f.kind, f.durationSec != null ? `${Math.round(f.durationSec)}s` : "", f.name ? `uploaded "${f.name}"` : f.tool ? `made by ${f.tool}` : ""];
      return `- ${f.ref} (${facts.filter(Boolean).join(", ")})`;
    });
}
