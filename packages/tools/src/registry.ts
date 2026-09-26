import { z } from "zod";
import { cropImage } from "./crop-image";
import { gptImage2 } from "./gpt-image-2";
import { mergeVideos } from "./merge-videos";
import type { AnyTool, FileKind } from "./types";

const TOOLS: AnyTool[] = [cropImage, gptImage2, mergeVideos];
const byName = new Map(TOOLS.map((t) => [t.name, t]));

export const getTool = (name: string) => byName.get(name);
export const listTools = () => TOOLS;

export type LlmToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

/** OpenAI-style function specs generated from each tool's Zod args. */
export function toolSpecs(): LlmToolSpec[] {
  return TOOLS.map((t) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(t.args, { io: "input" }) as Record<string, unknown>;
    return { type: "function", function: { name: t.name, description: t.description, parameters } };
  });
}

export type ParsedArgs = { ok: true; args: unknown } | { ok: false; message: string };

/** A file name the model can use in place of a URL: img_3, vid_1, aud_2 (or a hashed fallback for older files). */
export const FILE_REF = /^(img|vid|aud)_[a-z0-9]+$/;
const KIND_OF = { img: "image", vid: "video", aud: "audio" } as const satisfies Record<string, FileKind>;
const A_KIND: Record<FileKind, string> = { image: "an image", video: "a video", audio: "an audio file" };

/** Swap every file name inside the arguments for its URL; unknown names are collected, never guessed. */
type Resolve = { files: ReadonlyMap<string, string>; aliases: ReadonlyMap<string, string>; unknown: Set<string>; wrongKind: Set<string>; accepts?: FileKind };

function resolveRefs(raw: unknown, r: Resolve): unknown {
  // An uploaded file's original name is accepted when it names exactly one file in the chat.
  const value = typeof raw === "string" ? (r.aliases.get(raw) ?? raw) : raw;
  const { files, unknown, wrongKind, accepts } = r;
  if (typeof value === "string" && FILE_REF.test(value)) {
    if (accepts && KIND_OF[value.split("_")[0] as keyof typeof KIND_OF] !== accepts) wrongKind.add(value);
    const url = files.get(value);
    if (!url) unknown.add(value);
    return url ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, r));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, r)]));
  return value;
}

/** Parse raw model arguments; failures come back as a message the model can act on. */
export function parseArgs(tool: AnyTool, rawJson: string, files: ReadonlyMap<string, string> = new Map(), aliases: ReadonlyMap<string, string> = new Map()): ParsedArgs {
  let raw: unknown;
  try {
    raw = rawJson.trim() ? JSON.parse(rawJson) : {};
  } catch {
    return { ok: false, message: "Arguments were not valid JSON." };
  }
  const unknown = new Set<string>();
  const wrongKind = new Set<string>();
  const resolved = resolveRefs(tool.normalize ? tool.normalize(raw) : raw, { files, aliases, unknown, wrongKind, accepts: tool.accepts });
  if (wrongKind.size) {
    const names = [...wrongKind];
    return { ok: false, message: `${names.join(", ")} ${names.length > 1 ? "are" : "is"} not ${A_KIND[tool.accepts!]}; ${tool.name} only takes ${tool.accepts} files.` };
  }
  if (unknown.size) {
    const known = [...files.keys()];
    return {
      ok: false,
      message: `Unknown file ${[...unknown].join(", ")}. ${known.length ? `Files in this chat: ${known.join(", ")}.` : "No files are attached in this chat; ask the user to attach one."}`,
    };
  }
  const parsed = tool.args.safeParse(resolved);
  if (parsed.success) return { ok: true, args: parsed.data };
  return { ok: false, message: parsed.error.issues.map((i: z.core.$ZodIssue) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") };
}
