import type { SafeError } from "@gx/contracts";

export type MagicaErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "provider_credits"
  | "model_unavailable"
  | "rate_limited"
  | "provider_error"
  | "timeout";

const USER_MESSAGE: Record<MagicaErrorCode, string> = {
  invalid_input: "The tool rejected the input.",
  unauthorized: "The media service is misconfigured.",
  provider_credits: "The media service is out of credits.",
  model_unavailable: "This tool is temporarily unavailable.",
  rate_limited: "The media service is busy. Try again in a moment.",
  provider_error: "The media service had an error.",
  timeout: "The media service took too long to respond.",
};

export class MagicaError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: MagicaErrorCode,
    readonly status: number | null,
    readonly providerMessage?: string,
    readonly traceId?: string,
  ) {
    super(`magica ${code}${status ? ` (${status})` : ""}${providerMessage ? `: ${providerMessage}` : ""}`);
    this.name = "MagicaError";
    this.retryable = code === "rate_limited" || code === "provider_error" || code === "timeout";
  }

  toSafe(): SafeError {
    // Input errors carry Magica's own explanation so the model can correct itself.
    const message = this.code === "invalid_input" && this.providerMessage ? this.providerMessage : USER_MESSAGE[this.code];
    return { code: this.code, message, retryable: this.retryable };
  }
}

export function errorFromStatus(status: number, body: { message?: string; traceId?: string }): MagicaError {
  const code: MagicaErrorCode =
    status === 400 ? "invalid_input"
    : status === 401 ? "unauthorized"
    : status === 403 ? "provider_credits"
    : status === 404 || status === 410 ? "model_unavailable"
    : status === 429 ? "rate_limited"
    : "provider_error";
  return new MagicaError(code, status, body.message, body.traceId);
}
