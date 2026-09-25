import { prisma, isUniqueViolation } from "./client";

export type UserRow = { id: string; clerkId: string; balanceMicro: bigint };
const select = { id: true, clerkId: true, balanceMicro: true } as const;

/** Find or create the user for a Clerk id; a new user gets the signup grant exactly once. */
export async function ensureUser(clerkId: string, grantMicro: bigint): Promise<UserRow> {
  const existing = await prisma.user.findUnique({ where: { clerkId }, select });
  if (existing) return existing;
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { clerkId, balanceMicro: grantMicro }, select });
      await tx.creditLedger.create({
        data: { userId: user.id, deltaMicro: grantMicro, reason: "grant", idempotencyKey: `grant:${user.id}` },
      });
      return user;
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return prisma.user.findUniqueOrThrow({ where: { clerkId }, select }); // parallel first request won
  }
}

export const getBalance = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balanceMicro: true } })).balanceMicro;
