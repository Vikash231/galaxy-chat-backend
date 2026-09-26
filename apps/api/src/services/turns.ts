import { apiEnv } from "@gx/config";
import { AppError, type CancelResponse, type SendMessageBody, type SendMessageResponse } from "@gx/contracts";
import { admitTurn, attachTriggerRun, cancelRun, countRecentRuns, getOwnedChat, failStreamingReply, getOwnedRun, inFlightProviderCalls, isTerminalRun, loadRun, transitionRun, type UserRow } from "@gx/db";
import type { Logger } from "@gx/observability";
import { cancelTriggerRun, dispatchTurn, mintRunToken, reconcileProviderCall, triggerRunEnded } from "./realtime";

export type SendResult = { status: 200 | 202; data: SendMessageResponse };

/** Persist the user turn, dispatch exactly one durable run, and hand back realtime access. */
export async function sendTurn(user: UserRow, chatId: string, body: Omit<SendMessageBody, "planMode"> & { planMode?: boolean }, log: Logger): Promise<SendResult> {
  const env = apiEnv();
  await getOwnedChat(user.id, chatId);
  if ((await countRecentRuns(user.id, 60_000)) >= env.SEND_RATE_PER_MIN)
    throw new AppError("rate_limited", "You're sending messages too quickly. Wait a moment and try again.");
  if (user.balanceMicro < env.MIN_ADMISSION_MICRO) throw new AppError("insufficient_credits", "You're out of credits.");

  const admitted = await admitTurn({ userId: user.id, chatId, clientMessageId: body.clientMessageId, text: body.text, attachmentIds: body.attachmentIds, planMode: body.planMode });
  let triggerRunId = admitted.triggerRunId;

  if (!triggerRunId) {
    const run = await loadRun(admitted.runId);
    if (run?.status !== "queued") throw new AppError("run_not_dispatched", "This message could not be sent. Send it again.");
    try {
      triggerRunId = await dispatchTurn(admitted.runId, chatId, user.id);
      await attachTriggerRun(admitted.runId, triggerRunId);
    } catch (e) {
      log.error({ err: e, runId: admitted.runId }, "run.dispatch_failed");
      await transitionRun(admitted.runId, "failed", { error: { code: "dispatch_failed", message: "The reply could not be started.", retryable: true } });
      throw new AppError("dispatch_failed", "The reply could not be started. Try again.", { runId: admitted.runId });
    }
  }

  log.info({ runId: admitted.runId, chatId, triggerRunId, replay: admitted.replay }, admitted.replay ? "run.replayed" : "run.queued");
  return {
    status: admitted.replay ? 200 : 202,
    data: { chatId, messageId: admitted.messageId, runId: admitted.runId, realtime: await mintRunToken(triggerRunId) },
  };
}

const STOPPED = { code: "cancelled", message: "You stopped this reply.", retryable: true };

/**
 * Stop a turn. The API records the stop itself: a worker suspended on a tool is cancelled without running
 * any cleanup code. Magica jobs already accepted cannot be stopped, so they are finished and charged once.
 */
export async function stopTurn(user: UserRow, runId: string, log: Logger): Promise<CancelResponse> {
  const run = await getOwnedRun(user.id, runId);
  if (isTerminalRun(run.status)) return { runId: run.id, status: run.status };
  // Record the stop even if Trigger.dev refuses the cancel (e.g. the run already ended there).
  if (run.triggerRunId) await cancelTriggerRun(run.triggerRunId).catch((err) => log.warn({ err, triggerRunId: run.triggerRunId }, "run.cancel_trigger_failed"));
  await recordStop(run.id, log);
  return { runId: run.id, status: "cancelled" };
}

const LOST = { code: "run_lost", message: "This reply stopped unexpectedly. Send your message again.", retryable: true };

/**
 * A browser asks to watch a run: if Trigger.dev says it is over but Postgres still says active (the worker was
 * killed before it could record the end), fix Postgres first so the chat is not blocked forever.
 */
export async function watchTurn(user: UserRow, runId: string, log: Logger) {
  const run = await getOwnedRun(user.id, runId);
  if (!run.triggerRunId) throw new AppError("run_not_dispatched", "This reply never started.");
  if (isTerminalRun(run.status)) throw new AppError("run_finished", "This reply has finished.");
  const ended = await triggerRunEnded(run.triggerRunId);
  if (ended === "cancelled") await recordStop(run.id, log);
  else if (ended && (await transitionRun(run.id, "failed", { error: LOST }))) await failStreamingReply(run.id, LOST);
  if (ended) {
    log.warn({ runId: run.id, triggerRunId: run.triggerRunId, ended }, "run.recovered_stale");
    throw new AppError("run_finished", "This reply has finished.");
  }
  return mintRunToken(run.triggerRunId);
}

/** Mark the run and reply stopped, then finish any Magica job it had started so its cost is recorded once. */
async function recordStop(runId: string, log: Logger) {
  await cancelRun(runId, STOPPED);
  for (const { id } of await inFlightProviderCalls(runId)) {
    await reconcileProviderCall(id).catch((err) => log.error({ err, toolInvocationId: id }, "tool.reconcile_failed"));
    log.info({ toolInvocationId: id }, "tool.reconcile_started");
  }
  log.info({ runId }, "run.cancelled");
}
