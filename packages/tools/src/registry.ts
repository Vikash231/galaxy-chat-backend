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

/** Parse raw model arguments; failures come back as a message the model can act on. */
export function parseArgs(tool: AnyTool, rawJson: string): ParsedArgs {
  let raw: unknown;
  try {
    raw = rawJson.trim() ? JSON.parse(rawJson) : {};
  } catch {
    return { ok: false, message: "Arguments were not valid JSON." };
  }
  const parsed = tool.args.safeParse(tool.normalize ? tool.normalize(raw) : raw);
  if (parsed.success) return { ok: true, args: parsed.data };
  return { ok: false, message: parsed.error.issues.map((i: z.core.$ZodIssue) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") };
}
