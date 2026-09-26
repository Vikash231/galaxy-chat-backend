import { z } from "zod";
import { SafeError } from "./content";
import { WaitpointView } from "./waitpoints";

export const ToolStatus = z.enum(["pending", "dispatching", "running", "completed", "failed", "cancelled"]);
export type ToolStatus = z.infer<typeof ToolStatus>;

export const RunPhase = z.enum(["thinking", "working", "waiting", "complete", "failed", "cancelled", "stopping"]);
export type RunPhase = z.infer<typeof RunPhase>;

/** Run metadata: small state snapshot, overwritten on each change. */
export const RunMeta = z.object({
  status: RunPhase,
  step: z.number().int(),
  label: z.string().optional(),
  error: SafeError.optional(),
  waitpoint: WaitpointView.optional(),
  tools: z.record(
    z.string(),
    z.object({
      name: z.string(),
      status: ToolStatus,
      seq: z.number().int(),
      durationMs: z.number().int().optional(),
      credits: z.string().optional(),
      assetUrl: z.string().optional(),
      assetKind: z.enum(["image", "video", "audio"]).optional(),
      error: SafeError.optional(),
    }),
  ),
});
export type RunMeta = z.infer<typeof RunMeta>;

/** Token stream parts: append-only, tagged with the LLM step they belong to. */
export const StreamPart = z.object({
  t: z.enum(["text", "thinking"]),
  step: z.number().int(),
  d: z.string(),
});
export type StreamPart = z.infer<typeof StreamPart>;

export const ASSISTANT_STREAM_ID = "assistant";

export const AGENT_TURN_TASK = "agent-turn";
export const MAGICA_RUN_TASK = "magica-run";
export const RUN_META_KEY = "gx";
