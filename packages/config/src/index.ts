import { z } from "zod";

const micro = z.coerce.bigint().nonnegative();
const int = (d: number) => z.coerce.number().int().positive().default(d);

const shared = {
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NEW_USER_GRANT_MICRO: micro.default(5_000_000n),
  MIN_ADMISSION_MICRO: micro.default(5_000n),
};

export const ApiEnv = z.object({
  ...shared,
  NODE_ENV: z.string().default("development"),
  // Clerk's JWKS URL in production; CLERK_JWT_KEY (PEM) is for local dev tokens (scripts/dev-token.mjs).
  CLERK_JWKS_URL: z.string().url().optional(),
  CLERK_JWT_KEY: z.string().min(1).optional(),
  FRONTEND_ORIGIN: z.string().url(),
  // Optional so the API runs before Trigger.dev is set up; sending a message then returns 503 dispatch_failed.
  TRIGGER_SECRET_KEY: z.string().optional(),
  SEND_RATE_PER_MIN: int(10),
  TRANSLOADIT_AUTH_KEY: z.string().min(1).optional(),
  TRANSLOADIT_AUTH_SECRET: z.string().min(1).optional(),
  // Name of the R2 Template Credentials in the Transloadit console. Unset = temporary Transloadit URLs (dev only).
  TRANSLOADIT_R2_CREDENTIALS: z.string().min(1).optional(),
  R2_PUBLIC_URL: z.string().url().optional(),
  UPLOAD_MONTHLY_QUOTA_BYTES: z.coerce.number().int().positive().default(5 * 1024 ** 3), // Community plan: 5 GB/month
})
  .refine((e) => e.CLERK_JWKS_URL || e.CLERK_JWT_KEY, { message: "set CLERK_JWKS_URL (or CLERK_JWT_KEY for local dev)" })
  // A dev signing key must never be trusted in production.
  .refine((e) => e.NODE_ENV !== "production" || !e.CLERK_JWT_KEY, { message: "CLERK_JWT_KEY is dev-only; use CLERK_JWKS_URL in production" });

export const WorkerEnv = z.object({
  ...shared,
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  // The trial allows only the free router; anything else fails at boot.
  OPENROUTER_MODEL: z.literal("openrouter/free").default("openrouter/free"),
  MAGICA_API_KEY: z.string().min(1),
  MAGICA_BASE_URL: z.string().url().default("https://inference.magica.com"),
  MAGICA_MODE: z.enum(["fixture", "live"]).default("fixture"),
  MAGICA_DAILY_CAP_MICRO: micro.default(200_000n),
  AGENT_MAX_STEPS: int(8),
  // How long an unanswered question stays open, and the step cost at which the agent asks before spending.
  WAITPOINT_TTL_SECONDS: int(600),
  CREDIT_APPROVAL_MICRO: micro.default(10_000n),
  // History sent to the model: at most this many messages, trimmed to about this many tokens (newest turns kept).
  AGENT_HISTORY_LIMIT: int(200),
  AGENT_HISTORY_TOKENS: int(24_000),
  LLM_MAX_TOKENS: int(8_192),
  // Rolling summary: after a reply whose prompt passed LIMIT_TOKENS, or with more than LIMIT_MESSAGES messages
  // since the last summary, fold older messages into a summary and keep the newest KEEP_MESSAGES (fewer if
  // they would push the next prompt past TARGET_TOKENS).
  SUMMARY_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  SUMMARY_LIMIT_TOKENS: int(16_000),
  SUMMARY_LIMIT_MESSAGES: int(40),
  SUMMARY_KEEP_MESSAGES: int(10),
  SUMMARY_TARGET_TOKENS: int(6_000),
  AGENT_QUEUE_CONCURRENCY: int(50),
  TOOL_QUEUE_CONCURRENCY: int(10),
});

export type ApiEnv = z.infer<typeof ApiEnv>;
export type WorkerEnv = z.infer<typeof WorkerEnv>;

function loader<T extends z.ZodType>(schema: T, name: string) {
  let cached: z.infer<T> | undefined;
  return (): z.infer<T> => {
    if (cached) return cached;
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid ${name} environment: ${issues}`);
    }
    cached = parsed.data;
    return cached;
  };
}

export const apiEnv = loader(ApiEnv, "api");
export const workerEnv = loader(WorkerEnv, "worker");
