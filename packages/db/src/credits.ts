import { prisma, isUniqueViolation } from "./client";

/** Charge the user for one tool call exactly once; returns false if it was already charged. */
export async function settleToolCharge(p: { userId: string; runId: string; toolInvocationId: string; creditsMicro: bigint }) {
  if (p.creditsMicro <= 0n) return false;
  try {
    await prisma.$transaction([
      prisma.creditLedger.create({
        data: {
          userId: p.userId,
          runId: p.runId,
          toolInvocationId: p.toolInvocationId,
          deltaMicro: -p.creditsMicro,
          reason: "tool_charge",
          idempotencyKey: `tool:${p.toolInvocationId}`,
        },
      }),
      prisma.user.update({ where: { id: p.userId }, data: { balanceMicro: { decrement: p.creditsMicro } } }),
    ]);
    return true;
  } catch (e) {
    if (isUniqueViolation(e, "idempotencyKey")) return false;
    throw e;
  }
}

/** Reserve provider spend for today; false when it would exceed the cap. Concurrent callers cannot overshoot. */
export async function reserveProviderSpend(provider: string, estimateMicro: bigint, capMicro: bigint) {
  await prisma.$executeRaw`
    INSERT INTO "ProviderSpendDaily" (provider, day, "spentMicro") VALUES (${provider}, CURRENT_DATE, 0)
    ON CONFLICT DO NOTHING`;
  const updated = await prisma.$executeRaw`
    UPDATE "ProviderSpendDaily" SET "spentMicro" = "spentMicro" + ${estimateMicro}
    WHERE provider = ${provider} AND day = CURRENT_DATE AND "spentMicro" + ${estimateMicro} <= ${capMicro}`;
  return updated === 1;
}

/** Correct a reservation once the real cost is known (delta may be negative). */
export const adjustProviderSpend = (provider: string, deltaMicro: bigint) =>
  deltaMicro === 0n
    ? Promise.resolve(0)
    : prisma.$executeRaw`
        UPDATE "ProviderSpendDaily" SET "spentMicro" = GREATEST(0, "spentMicro" + ${deltaMicro})
        WHERE provider = ${provider} AND day = CURRENT_DATE`;
