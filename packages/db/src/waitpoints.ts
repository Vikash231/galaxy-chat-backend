import type { Prisma, Waitpoint } from "@prisma/client";
import { AppError, WaitpointRequest, type WaitpointAnswer, type WaitpointView } from "@gx/contracts";
import { isUniqueViolation, prisma } from "./client";

export const toWaitpointView = (w: Waitpoint): WaitpointView => ({
  id: w.id,
  kind: w.kind,
  request: WaitpointRequest.parse(w.request),
  expiresAt: w.expiresAt.toISOString(),
});

export type NewWaitpoint = { runId: string; key: string; request: WaitpointRequest; expiresAt: Date };

/** One row per (run, key): asking the same question again returns the existing row, whatever state it is in. */
export async function upsertWaitpoint(w: NewWaitpoint): Promise<Waitpoint> {
  try {
    const request = WaitpointRequest.parse(w.request);
    return await prisma.waitpoint.create({ data: { runId: w.runId, key: w.key, kind: request.kind, request: request as Prisma.InputJsonValue, expiresAt: w.expiresAt } });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return prisma.waitpoint.findUniqueOrThrow({ where: { runId_key: { runId: w.runId, key: w.key } } });
  }
}

/** Ownership goes through the run; someone else's question looks like a missing one. */
export async function getOwnedWaitpoint(userId: string, id: string) {
  const w = await prisma.waitpoint.findFirst({ where: { id, run: { userId } } });
  if (!w) throw new AppError("not_found", "Question not found.");
  return w;
}

export const getWaitpoint = (id: string) => prisma.waitpoint.findUniqueOrThrow({ where: { id } });

export const setWaitpointToken = (id: string, tokenId: string) => prisma.waitpoint.update({ where: { id }, data: { tokenId } });

/** The run's open question, if any. */
export const pendingWaitpoint = (runId: string) =>
  prisma.waitpoint.findFirst({ where: { runId, status: "pending", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });

/** Mark an unanswered waitpoint expired; false if it was answered or cancelled first. */
export async function expireWaitpoint(id: string): Promise<boolean> {
  const { count } = await prisma.waitpoint.updateMany({ where: { id, status: "pending" }, data: { status: "expired" } });
  return count === 1;
}

export type AnswerResult = { result: "answered" | "duplicate"; waitpoint: Waitpoint };

/**
 * Record the user's answer exactly once. The first answer wins; the same answer again is a duplicate
 * (the caller re-wakes the run); anything after expiry, a stop, or a different answer is refused.
 */
export async function answerWaitpoint(userId: string, id: string, answer: WaitpointAnswer): Promise<AnswerResult> {
  await getOwnedWaitpoint(userId, id);

  const { count } = await prisma.waitpoint.updateMany({
    where: { id, status: "pending", expiresAt: { gt: new Date() } },
    data: { status: "answered", answer: answer as Prisma.InputJsonValue, answeredAt: new Date() },
  });
  const waitpoint = await getWaitpoint(id);
  if (count === 1) return { result: "answered", waitpoint };
  if (waitpoint.status === "answered") {
    if (JSON.stringify(waitpoint.answer) === JSON.stringify(answer)) return { result: "duplicate", waitpoint };
    throw new AppError("waitpoint_closed", "This question was already answered.");
  }
  throw new AppError("waitpoint_closed", waitpoint.status === "expired" || waitpoint.expiresAt <= new Date() ? "This question expired. Send a message to continue." : "This question is no longer open.");
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** The most this run may spend without asking again: the biggest approved plan estimate or approved credit total. Null = nothing approved. */
export async function approvedCapMicro(runId: string): Promise<bigint | null> {
  const rows = await prisma.waitpoint.findMany({ where: { runId, status: "answered", kind: { in: ["plan", "credit"] } }, select: { kind: true, request: true, answer: true } });
  let cap: bigint | null = null;
  for (const r of rows) {
    if (!(r.answer && typeof r.answer === "object" && "approve" in r.answer && r.answer.approve === true)) continue;
    const req = r.request as { estimateMicro?: unknown; totalMicro?: unknown };
    const v = BigInt(r.kind === "plan" ? num(req.estimateMicro) : num(req.totalMicro));
    if (cap === null || v > cap) cap = v;
  }
  return cap;
}

/** Estimated spend so far in a run: the sum of its tool calls' estimates. */
export async function spentEstimateMicro(runId: string): Promise<bigint> {
  const { _sum } = await prisma.toolInvocation.aggregate({ where: { runId }, _sum: { estimateMicro: true } });
  return _sum.estimateMicro ?? 0n;
}
