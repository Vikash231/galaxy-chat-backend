import { apiEnv } from "@gx/config";
import { AppError, type SendMessageBody, type SendMessageResponse } from "@gx/contracts";
import { admitTurn, attachTriggerRun, countRecentRuns, getOwnedChat, loadRun, transitionRun, type UserRow } from "@gx/db";
import type { Logger } from "@gx/observability";
import { dispatchTurn, mintRunToken } from "./realtime";

export type SendResult = { status: 200 | 202; data: SendMessageResponse };

/** Persist the user turn, dispatch exactly one durable run, and hand back realtime access. */
export async function sendTurn(user: UserRow, chatId: string, body: SendMessageBody, log: Logger): Promise<SendResult> {
  const env = apiEnv();
  await getOwnedChat(user.id, chatId);
  if ((await countRecentRuns(user.id, 60_000)) >= env.SEND_RATE_PER_MIN)
    throw new AppError("rate_limited", "You're sending messages too quickly. Wait a moment and try again.");
  if (user.balanceMicro < env.MIN_ADMISSION_MICRO) throw new AppError("insufficient_credits", "You're out of credits.");

  const admitted = await admitTurn({ userId: user.id, chatId, clientMessageId: body.clientMessageId, text: body.text, attachmentIds: body.attachmentIds });
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
