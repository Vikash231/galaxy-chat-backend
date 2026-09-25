import type { z } from "zod";

export type Asset = { kind: "image" | "video" | "audio"; url: string };

/** One agent tool: its LLM-facing contract plus how to execute it. Adding a tool never touches orchestration. */
export interface ToolDef<A extends z.ZodObject = z.ZodObject, O = unknown> {
  name: string;
  description: string;
  /** Present-tense label shown while the tool runs. */
  label: string;
  args: A;
  /** Optional reshaping of raw model arguments (aliases) before validation. */
  normalize?: (raw: unknown) => unknown;
  output: z.ZodType<O>;
  estimateMicro: (args: z.infer<A>) => bigint;
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
