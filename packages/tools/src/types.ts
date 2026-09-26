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
  exec: {
    kind: "magica";
    nodeType: string;
    subModelId?: (args: z.infer<A>) => string | undefined;
    toInput: (args: z.infer<A>) => Record<string, unknown>;
    fromOutput: (raw: unknown) => O;
  };
}

// Variance on the generic makes a heterogeneous registry awkward; the registry erases it once, here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any, any>;
