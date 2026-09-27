import type { Prisma, RunStatus } from "@prisma/client";
import { AppError, ACTIVE_RUN_STATUSES, type RunView, type SafeError } from "@gx/contracts";
import { prisma, isUniqueViolation } from "./client";
import { errorCols, readError } from "./errors";
import { toMessageView } from "./messages";
import { claimAttachments } from "./attachments";
import { getOwnedChat } from "./chats";
import { inFlightProviderCalls } from "./tools";
import { pendingWaitpoint, toWaitpointView } from "./waitpoints";

const pendingWaitpointView = async (runId: string) => {
  const w = await pendingWaitpoint(runId);
  return w ? toWaitpointView(w) : null;
};

const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];
export const isTerminalRun = (s: RunStatus) => TERMINAL.includes(s);

export type AdmitInput = { userId: string; chatId: string; clientMessageId: string; text: string; attachmentIds?: string[]; planMode?: boolean };
export type Admitted = { runId: string; messageId: string; triggerRunId: string | null; replay: boolean };

/**
 * Persist the user message and a queued run in one transaction.
 * Replays of the same clientMessageId return the original run; a second active run in the chat is rejected.
 */
export async function admitTurn(input: AdmitInput): Promise<Admitted> {
  try {
    return await prisma.$transaction(async (tx) => {
      // First, so a chat deleted a moment ago gets no new message or run.
      const { count } = await tx.chat.updateMany({ where: { id: input.chatId, userId: input.userId, deletedAt: null }, data: { updatedAt: new Date() } });
      if (count === 0) throw new AppError("not_found", "Chat not found.");
      const message = await tx.message.create({
        data: { chatId: input.chatId, role: "user", clientMessageId: input.clientMessageId, content: [] },
      });
      const attached = await claimAttachments(tx, input.userId, input.chatId, message.id, input.attachmentIds ?? []);
      await tx.message.update({ where: { id: message.id }, data: { content: [...attached, { type: "text", text: input.text }] as Prisma.InputJsonValue } });
      const run = await tx.agentRun.create({
        data: { chatId: input.chatId, userId: input.userId, userMessageId: message.id, planMode: input.planMode ?? false },
      });
      return { runId: run.id, messageId: message.id, triggerRunId: null, replay: false };
    });
  } catch (e) {
    if (isUniqueViolation(e, "clientMessageId")) {
      const message = await prisma.message.findUniqueOrThrow({
        where: { chatId_clientMessageId: { chatId: input.chatId, clientMessageId: input.clientMessageId } },
      });
      // The first run of this message (a retry shares the message but is not what a resend should return).
      const run = await prisma.agentRun.findFirstOrThrow({ where: { userMessageId: message.id, retryOfRunId: null } });
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

const NOT_RETRYABLE_HINT: Record<string, string> = {
  insufficient_credits: "You're out of credits. Add credits, then send your message again.",
};

/**
 * Create a new run for the same user message after a failed or stopped reply.
 * Refused when it could pay twice (a Magica job from the old run is still finishing), when it is not the
 * newest reply, or when the failure cannot be fixed by trying again. Asking twice returns the same retry.
 */
export async function admitRetry(userId: string, runId: string): Promise<Admitted> {
  const run = await getOwnedRun(userId, runId);
  await getOwnedChat(userId, run.chatId);

  const existing = await prisma.agentRun.findUnique({ where: { retryOfRunId: run.id } });
  if (existing) return { runId: existing.id, messageId: run.userMessageId, triggerRunId: existing.triggerRunId, replay: true };

  if (run.status !== "failed" && run.status !== "cancelled") throw new AppError("run_not_retryable", "Only a failed or stopped reply can be retried.");
  const error = readError(run);
  if (error && error.retryable === false)
    throw new AppError("run_not_retryable", NOT_RETRYABLE_HINT[error.code] ?? "This failure cannot be fixed by trying again.", { code: error.code });
  const newer = await prisma.agentRun.findFirst({ where: { chatId: run.chatId, createdAt: { gt: run.createdAt } }, select: { id: true } });
  if (newer) throw new AppError("run_not_retryable", "Only the latest reply can be retried.");
  if ((await inFlightProviderCalls(run.id)).length)
    throw new AppError("run_not_retryable", "The previous image is still finishing. Try again in a minute, so it is not paid for twice.");

  try {
    return await prisma.$transaction(async (tx) => {
      const { count } = await tx.chat.updateMany({ where: { id: run.chatId, userId, deletedAt: null }, data: { updatedAt: new Date() } });
      if (count === 0) throw new AppError("not_found", "Chat not found.");
      const created = await tx.agentRun.create({
        data: { chatId: run.chatId, userId, userMessageId: run.userMessageId, retryOfRunId: run.id, planMode: run.planMode },
      });
      return { runId: created.id, messageId: run.userMessageId, triggerRunId: null, replay: false };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // A concurrent retry of the same run wins either unique index (its own, or one-active-run-per-chat): return it.
      const again = await prisma.agentRun.findUnique({ where: { retryOfRunId: run.id } });
      if (again) return { runId: again.id, messageId: run.userMessageId, triggerRunId: again.triggerRunId, replay: true };
      const active = await prisma.agentRun.findFirst({ where: { chatId: run.chatId, status: { in: [...ACTIVE_RUN_STATUSES] } }, select: { id: true } });
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
      lastPromptTokens: promptTokens,
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
    waitpoint: await pendingWaitpointView(run.id),
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

/**
 * Mark a run and its reply stopped, keeping the reply's saved content. Run by the API because a worker
 * suspended on a tool is cancelled without running any of its code.
 */
export async function cancelRun(runId: string, error: SafeError): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.agentRun.updateMany({
      where: { id: runId, status: { notIn: TERMINAL } },
      data: { status: "cancelled", finishedAt: new Date(), ...errorCols(error) },
    });
    await tx.message.updateMany({ where: { runId, status: "streaming" }, data: { status: "cancelled", ...errorCols(error) } });
    await tx.waitpoint.updateMany({ where: { runId, status: "pending" }, data: { status: "cancelled" } });
    return count === 1;
  });
}
