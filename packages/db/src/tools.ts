import type { Prisma, ToolStatus } from "@prisma/client";
import type { SafeError } from "@gx/contracts";
import { prisma } from "./client";
import { errorCols } from "./errors";

const TERMINAL: ToolStatus[] = ["completed", "failed", "cancelled"];
export const isTerminalTool = (s: ToolStatus) => TERMINAL.includes(s);

export type InvocationInput = {
  runId: string;
  toolCallId: string;
  seq: number;
  name: string;
  input: unknown;
  estimateMicro: bigint;
};

/** One row per (run, toolCallId); a retried turn gets the existing row back instead of new work. */
export const upsertInvocation = (i: InvocationInput) =>
  prisma.toolInvocation.upsert({
    where: { runId_toolCallId: { runId: i.runId, toolCallId: i.toolCallId } },
    create: { ...i, input: i.input as Prisma.InputJsonValue },
    update: {},
  });

export const getInvocation = (id: string) => prisma.toolInvocation.findUniqueOrThrow({ where: { id } });

/** Provider calls of a run that Magica accepted but that have not finished yet. */
export const inFlightProviderCalls = (runId: string) =>
  prisma.toolInvocation.findMany({ where: { runId, status: { in: ["dispatching", "running"] }, magicaRunId: { not: null } }, select: { id: true } });

/** Claim the right to call the provider; false means another attempt already did. */
export async function markDispatching(id: string): Promise<boolean> {
  const { count } = await prisma.toolInvocation.updateMany({
    where: { id, status: "pending" },
    data: { status: "dispatching", startedAt: new Date() },
  });
  return count === 1;
}

export const markRunning = (id: string, magicaRunId: string) =>
  prisma.toolInvocation.update({ where: { id }, data: { status: "running", magicaRunId } });

export type ToolOutcome = {
  status: "completed" | "failed" | "cancelled";
  output?: unknown;
  creditsMicro?: bigint;
  error?: SafeError;
};

export async function finishInvocation(id: string, o: ToolOutcome) {
  const inv = await getInvocation(id);
  const finishedAt = new Date();
  await prisma.toolInvocation.updateMany({
    where: { id, status: { notIn: TERMINAL } },
    data: {
      status: o.status,
      output: (o.output ?? undefined) as Prisma.InputJsonValue | undefined,
      creditsMicro: o.creditsMicro ?? 0n,
      finishedAt,
      durationMs: inv.startedAt ? finishedAt.getTime() - inv.startedAt.getTime() : null,
      ...errorCols(o.error),
    },
  });
  return getInvocation(id);
}

/** Undo a claim when the provider definitely rejected the call (429/5xx), so a retry may dispatch again. */
export const releaseDispatch = (id: string) =>
  prisma.toolInvocation.updateMany({ where: { id, status: "dispatching", magicaRunId: null }, data: { status: "pending", startedAt: null } });
