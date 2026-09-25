import { z } from "zod";

export const MagicaRunStatus = z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELED"]);
export type MagicaRunStatus = z.infer<typeof MagicaRunStatus>;

export const MagicaRun = z.object({
  id: z.string(),
  nodeType: z.string(),
  status: MagicaRunStatus,
  output: z.unknown().nullable().optional(),
  error: z.string().nullable().optional(),
  userMessage: z.string().nullable().optional(),
  creditUsed: z.number().nonnegative().default(0), // microcredits
});
export type MagicaRun = z.infer<typeof MagicaRun>;

export const isMagicaTerminal = (r: MagicaRun) => r.status === "COMPLETED" || r.status === "FAILED" || r.status === "CANCELED";

export type RunRequest = {
  input: Record<string, unknown>;
  subModelId?: string;
  webhook?: { url: string; events?: ("run.started" | "run.completed" | "run.failed" | "run.canceled")[] };
};
