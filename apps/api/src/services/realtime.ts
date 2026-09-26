import { auth, runs, tasks } from "@trigger.dev/sdk";
import { AGENT_TURN_TASK, MAGICA_RUN_TASK, type RealtimeAccess } from "@gx/contracts";

const TOKEN_TTL_SECONDS = 60 * 60;

/** A browser token that can only read this one run, for one hour. */
export async function mintRunToken(triggerRunId: string): Promise<RealtimeAccess> {
  const publicAccessToken = await auth.createPublicToken({
    scopes: { read: { runs: [triggerRunId] } },
    expirationTime: `${TOKEN_TTL_SECONDS}s`,
  });
  return { triggerRunId, publicAccessToken, expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString() };
}

/** Start the durable turn; the idempotency key makes a repeated dispatch of the same run a no-op. */
export async function dispatchTurn(runId: string, chatId: string, userId: string) {
  const handle = await tasks.trigger(
    AGENT_TURN_TASK,
    { runId },
    { idempotencyKey: runId, concurrencyKey: chatId, tags: [`chat_${chatId}`, `user_${userId}`] },
  );
  return handle.id;
}

export const cancelTriggerRun = (triggerRunId: string) => runs.cancel(triggerRunId);

/**
 * Finish a provider call whose turn was stopped, as a standalone run the cancel cannot reach. It reuses the
 * stored Magica run id (never a second job), waits for the result and charges the user once.
 */
export const reconcileProviderCall = (toolInvocationId: string) =>
  tasks.trigger(MAGICA_RUN_TASK, { toolInvocationId }, { idempotencyKey: `magica-reconcile:${toolInvocationId}` });

/** Whether Trigger.dev considers the run over, and how it ended. */
export async function triggerRunEnded(triggerRunId: string): Promise<"cancelled" | "ended" | null> {
  const r = await runs.retrieve(triggerRunId);
  if (r.isCancelled) return "cancelled";
  return r.isCompleted ? "ended" : null;
}
