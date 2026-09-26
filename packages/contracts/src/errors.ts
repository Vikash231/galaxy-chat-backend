import { z } from "zod";

export const ErrorCode = z.enum([
  "unauthenticated",
  "insufficient_credits",
  "not_found",
  "run_active",
  "run_not_dispatched",
  "run_finished",
  "waitpoint_closed",
  "run_not_retryable",
  "validation_failed",
  "rate_limited",
  "upload_not_ready",
  "upload_rejected",
  "upload_quota",
  "dispatch_failed",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const httpStatus: Record<ErrorCode, number> = {
  unauthenticated: 401,
  insufficient_credits: 402,
  not_found: 404,
  run_active: 409,
  run_not_dispatched: 409,
  run_finished: 409,
  waitpoint_closed: 409,
  run_not_retryable: 409,
  validation_failed: 422,
  rate_limited: 429,
  upload_not_ready: 409,
  upload_rejected: 422,
  upload_quota: 429,
  dispatch_failed: 503,
  internal: 500,
};

/** An error that is safe to show the user as-is. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    traceId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
