import pino from "pino";

export type LogContext = Partial<{
  traceId: string;
  userId: string;
  chatId: string;
  runId: string;
  messageId: string;
  triggerRunId: string;
  toolInvocationId: string;
  magicaRunId: string;
  waitpointTokenId: string;
}>;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "unknown" },
  redact: {
    paths: ["authorization", "*.authorization", "headers.authorization", "*.apiKey", "apiKey", "*.token", "publicAccessToken", "*.publicAccessToken"],
    censor: "[redacted]",
  },
});

export type Logger = pino.Logger;

/** A child logger carrying the ids that tie one request or run together. */
export const withContext = (ctx: LogContext, parent: Logger = logger) => parent.child(ctx);
