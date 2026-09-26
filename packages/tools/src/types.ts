import type { z } from "zod";

export type FileKind = "image" | "video" | "audio";
export type Asset = { kind: FileKind; url: string; durationSec?: number };

/** What a tool may know about its input files when estimating cost. */
export type FileFacts = { durationSec(url: string): number | undefined };

/** One agent tool: its LLM-facing contract plus how to execute it. Adding a tool never touches orchestration. */
export interface ToolDef<A extends z.ZodObject = z.ZodObject, O = unknown> {
  name: string;
  description: string;
  /** Present-tense label shown while the tool runs. */
  label: string;
  args: A;
  /** The one file type this tool takes; names of other types are rejected before any spend. */
  accepts?: FileKind;
  /** Optional reshaping of raw model arguments (aliases) before validation. */
  normalize?: (raw: unknown) => unknown;
  output: z.ZodType<O>;
  estimateMicro: (args: z.infer<A>, files: FileFacts) => bigint;
  assets: (output: O) => Asset[];
  exec: MagicaExec<A, O> | LocalExec<A, O>;
}

/** Runs as a Magica model through the magica-run child task; billed. */
export type MagicaExec<A extends z.ZodObject, O> = {
  kind: "magica";
  nodeType: string;
  subModelId?: (args: z.infer<A>) => string | undefined;
  toInput: (args: z.infer<A>) => Record<string, unknown>;
  fromOutput: (raw: unknown) => O;
};

/** What in-process tools may use from the running turn. */
export type LocalCtx = { recordSkill(name: string, contentHash: string, content: string): Promise<{ contentHash: string; content: string; first: boolean }> };

/** Runs inside the agent worker (e.g. reading skills); free. */
export type LocalExec<A extends z.ZodObject, O> = { kind: "local"; run: (args: z.infer<A>, ctx: LocalCtx) => Promise<O> };

export type MagicaTool<A extends z.ZodObject, O> = ToolDef<A, O> & { exec: MagicaExec<A, O> };

/** A failure the model can act on (its message is shown to the model and the user). */
export class ToolRunError extends Error {}

// Variance on the generic makes a heterogeneous registry awkward; the registry erases it once, here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any, any>;
