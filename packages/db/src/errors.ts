import type { SafeError } from "@gx/contracts";

type ErrorCols = { errorCode: string | null; errorMessage: string | null; errorRetryable: boolean | null };

export const errorCols = (e: SafeError | null | undefined): ErrorCols => ({
  errorCode: e?.code ?? null,
  errorMessage: e?.message ?? null,
  errorRetryable: e?.retryable ?? null,
});

export const readError = (r: ErrorCols): SafeError | null =>
  r.errorCode ? { code: r.errorCode, message: r.errorMessage ?? "", retryable: r.errorRetryable ?? false } : null;
