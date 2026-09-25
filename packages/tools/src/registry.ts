import { z } from "zod";
import { cropImage } from "./crop-image";
import type { AnyTool } from "./types";

const TOOLS: AnyTool[] = [cropImage];
const byName = new Map(TOOLS.map((t) => [t.name, t]));

export const getTool = (name: string) => byName.get(name);
export const listTools = () => TOOLS;

export type LlmToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

/** OpenAI-style function specs generated from each tool's Zod args. */
export function toolSpecs(): LlmToolSpec[] {
  return TOOLS.map((t) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(t.args) as Record<string, unknown>;
    return { type: "function", function: { name: t.name, description: t.description, parameters } };
  });
}

export type ParsedArgs = { ok: true; args: unknown } | { ok: false; message: string };

/** A file name the model can use in place of a URL: img_3, vid_1, aud_2 (or a hashed fallback for older files). */
export const FILE_REF = /^(img|vid|aud)_[a-z0-9]+$/;

/** Swap every file name inside the arguments for its URL; unknown names are collected, never guessed. */
function resolveRefs(value: unknown, files: ReadonlyMap<string, string>, unknown: Set<string>): unknown {
  if (typeof value === "string" && FILE_REF.test(value)) {
    const url = files.get(value);
    if (!url) unknown.add(value);
    return url ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, files, unknown));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, files, unknown)]));
  return value;
}

/** Parse raw model arguments; failures come back as a message the model can act on. */
export function parseArgs(tool: AnyTool, rawJson: string, files: ReadonlyMap<string, string> = new Map()): ParsedArgs {
  let raw: unknown;
  try {
    raw = rawJson.trim() ? JSON.parse(rawJson) : {};
  } catch {
    return { ok: false, message: "Arguments were not valid JSON." };
  }
  const unknown = new Set<string>();
  const resolved = resolveRefs(tool.normalize ? tool.normalize(raw) : raw, files, unknown);
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
