import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { __prisma?: PrismaClient };

/** One client per process; reused across hot reloads in dev. */
export const prisma = g.__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.__prisma = prisma;

export type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

/** Postgres unique violation, optionally on a specific constraint/field. */
export function isUniqueViolation(e: unknown, target?: string): boolean {
  const err = e as { code?: string; meta?: { target?: string | string[] } };
  if (err?.code !== "P2002") return false;
  if (!target) return true;
  const t = err.meta?.target;
  return Array.isArray(t) ? t.includes(target) : typeof t === "string" && t.includes(target);
}
