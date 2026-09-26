import { z } from "zod";

export const WaitpointKind = z.enum(["options", "plan", "credit", "media"]);
export type WaitpointKind = z.infer<typeof WaitpointKind>;

export const WaitpointStatus = z.enum(["pending", "answered", "expired", "cancelled"]);
export type WaitpointStatus = z.infer<typeof WaitpointStatus>;

/** One step of a proposed plan. `args` is the tool's arguments as a JSON string so file names that do not exist yet survive parsing. */
export const PlanStep = z.object({
  text: z.string().min(1).max(300),
  tool: z.string().max(60).optional(),
  args: z.string().max(4000).optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const MAX_OPTIONS = 6;
export const MAX_PLAN_STEPS = 10;
export const MAX_MEDIA_CHOICES = 10;

export const WaitpointRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("options"), question: z.string().min(1).max(300), options: z.array(z.string().min(1).max(120)).min(2).max(MAX_OPTIONS) }),
  z.object({
    kind: z.literal("media"),
    question: z.string().min(1).max(300),
    files: z.array(z.object({ name: z.string(), url: z.string().url(), kind: z.enum(["image", "video", "audio"]) })).min(1).max(MAX_MEDIA_CHOICES),
  }),
  // estimateMicro is computed by the server from the tools' own estimates, never taken from the model.
  z.object({ kind: z.literal("plan"), summary: z.string().min(1).max(500), steps: z.array(PlanStep).min(1).max(MAX_PLAN_STEPS), estimateMicro: z.number().int().nonnegative() }),
  // totalMicro is the run's cumulative estimated spend if approved (already spent + this step).
  z.object({
    kind: z.literal("credit"),
    tools: z.array(z.object({ name: z.string(), estimateMicro: z.number().int().nonnegative() })).min(1),
    stepMicro: z.number().int().nonnegative(),
    totalMicro: z.number().int().nonnegative(),
  }),
]);
export type WaitpointRequest = z.infer<typeof WaitpointRequest>;

/** options/media answer with `choice`; plan/credit answer with `approve`. */
export const WaitpointAnswer = z.union([
  z.object({ choice: z.string().min(1).max(500) }),
  z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }),
]);
export type WaitpointAnswer = z.infer<typeof WaitpointAnswer>;

export const WaitpointParams = z.object({ waitpointId: z.string().min(1).max(64) });

/** What a client needs to draw the pending question. */
export const WaitpointView = z.object({
  id: z.string(),
  kind: WaitpointKind,
  request: WaitpointRequest,
  expiresAt: z.string().datetime(),
});
export type WaitpointView = z.infer<typeof WaitpointView>;

export const AnswerWaitpointResponse = z.object({ id: z.string(), status: WaitpointStatus });
export type AnswerWaitpointResponse = z.infer<typeof AnswerWaitpointResponse>;

/** Whether an answer fits the question; the offered values are the only valid choices. */
export function checkAnswer(request: WaitpointRequest, answer: WaitpointAnswer): string | null {
  if (request.kind === "options") return "choice" in answer && request.options.includes(answer.choice) ? null : "Pick one of the offered options.";
  if (request.kind === "media") return "choice" in answer && request.files.some((f) => f.name === answer.choice) ? null : "Pick one of the offered files.";
  return "approve" in answer ? null : "Answer with approve true or false.";
}
