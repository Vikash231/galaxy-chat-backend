import { auth, runs, tasks } from "@trigger.dev/sdk";
import { AGENT_TURN_TASK, type RealtimeAccess } from "@gx/contracts";

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
