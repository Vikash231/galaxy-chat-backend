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
  const seen = new Map<string, string | null>();
  for (const m of history)
    for (const b of m.content) if (b.type === "attachment") seen.set(b.name, seen.has(b.name) ? null : refOf(b));
  return new Map([...seen].filter((e): e is [string, string] => e[1] !== null));
}

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
