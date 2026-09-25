import type { Prisma, RunStatus } from "@prisma/client";
import { AppError, ACTIVE_RUN_STATUSES, type RunView, type SafeError } from "@gx/contracts";
import { prisma, isUniqueViolation } from "./client";
import { errorCols, readError } from "./errors";
import { toMessageView } from "./messages";
import { claimAttachments } from "./attachments";

const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];
export const isTerminalRun = (s: RunStatus) => TERMINAL.includes(s);

export type AdmitInput = { userId: string; chatId: string; clientMessageId: string; text: string; attachmentIds?: string[] };
export type Admitted = { runId: string; messageId: string; triggerRunId: string | null; replay: boolean };

/**
 * Persist the user message and a queued run in one transaction.
 * Replays of the same clientMessageId return the original run; a second active run in the chat is rejected.
 */
export async function admitTurn(input: AdmitInput): Promise<Admitted> {
  try {
    return await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: { chatId: input.chatId, role: "user", clientMessageId: input.clientMessageId, content: [] },
      });
      const attached = await claimAttachments(tx, input.userId, message.id, input.attachmentIds ?? []);
      await tx.message.update({ where: { id: message.id }, data: { content: [...attached, { type: "text", text: input.text }] as Prisma.InputJsonValue } });
      const run = await tx.agentRun.create({
        data: { chatId: input.chatId, userId: input.userId, userMessageId: message.id },
      });
      await tx.chat.update({ where: { id: input.chatId }, data: { updatedAt: new Date() } });
      return { runId: run.id, messageId: message.id, triggerRunId: null, replay: false };
    });
  } catch (e) {
    if (isUniqueViolation(e, "clientMessageId")) {
      const message = await prisma.message.findUniqueOrThrow({
        where: { chatId_clientMessageId: { chatId: input.chatId, clientMessageId: input.clientMessageId } },
      });
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { userMessageId: message.id } });
      return { runId: run.id, messageId: message.id, triggerRunId: run.triggerRunId, replay: true };
    }
    if (isUniqueViolation(e)) {
      const active = await prisma.agentRun.findFirst({
        where: { chatId: input.chatId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      });
      throw new AppError("run_active", "A reply is still in progress in this chat.", { activeRunId: active?.id });
    }
    throw e;
  }
}

export const attachTriggerRun = (runId: string, triggerRunId: string) =>
  prisma.agentRun.update({ where: { id: runId }, data: { triggerRunId } });

/** Move a run to a new status unless it already finished; terminal states are final. */
export async function transitionRun(
  runId: string,
  status: RunStatus,
  extra: { error?: SafeError | null } = {},
): Promise<boolean> {
  const { count } = await prisma.agentRun.updateMany({
    where: { id: runId, status: { notIn: TERMINAL } },
    data: {
      status,
      ...(extra.error !== undefined && errorCols(extra.error)),
      ...(TERMINAL.includes(status) && { finishedAt: new Date() }),
    },
  });
  return count === 1;
}

export const countRecentRuns = (userId: string, sinceMs: number) =>
  prisma.agentRun.count({ where: { userId, createdAt: { gte: new Date(Date.now() - sinceMs) } } });

export async function getOwnedRun(userId: string, runId: string) {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new AppError("not_found", "Run not found.");
  return run;
}

export const loadRun = (runId: string) => prisma.agentRun.findUnique({ where: { id: runId } });

export const recordStep = (runId: string, step: number, model: string, promptTokens: number, completionTokens: number) =>
  prisma.agentRun.update({
    where: { id: runId },
    data: {
      steps: step + 1,
      routedModels: { push: model },
      promptTokens: { increment: promptTokens },
      completionTokens: { increment: completionTokens },
    },
  });

export async function getRunView(userId: string, runId: string): Promise<RunView> {
  await getOwnedRun(userId, runId);
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: { tools: { orderBy: { seq: "asc" } }, assistantMessage: true },
  });
  return {
    run: {
      id: run.id,
      chatId: run.chatId,
      status: run.status,
      steps: run.steps,
      routedModels: run.routedModels,
      error: readError(run),
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    },
    tools: run.tools.map((t) => ({
      toolCallId: t.toolCallId,
      seq: t.seq,
      name: t.name,
      status: t.status,
      input: t.input,
      output: t.output ?? null,
      durationMs: t.durationMs,
      credits: t.creditsMicro.toString(),
      error: readError(t),
    })),
    assistantMessage: run.assistantMessage ? toMessageView(run.assistantMessage) : null,
  };
}


/** Claim a queued run for execution; also records the Trigger run id if the API never got to save it. */
export async function startRun(runId: string, triggerRunId: string): Promise<boolean> {
  const { count } = await prisma.agentRun.updateMany({
    where: { id: runId, status: { in: ["queued", "running"] } },
    data: { status: "running", triggerRunId },
  });
  return count === 1;
}
