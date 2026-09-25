import { RunParams } from "@gx/contracts";
import { getOwnedRun, isTerminalRun, transitionRun } from "@gx/db";
import { withRoute } from "../../../../../../http/with-route";
import { cancelTriggerRun } from "../../../../../../services/realtime";

const CANCELLED = { code: "cancelled", message: "You stopped this reply.", retryable: true };

export const POST = withRoute({ params: RunParams }, async ({ user, params, log }) => {
  const run = await getOwnedRun(user.id, params.runId);
  if (isTerminalRun(run.status)) return { data: { runId: run.id, status: run.status } };
  // Not dispatched yet: nothing is running, so finish it here. Otherwise the worker finalizes on abort.
  if (!run.triggerRunId) {
    await transitionRun(run.id, "cancelled", { error: CANCELLED });
    return { data: { runId: run.id, status: "cancelled" } };
  }
  await cancelTriggerRun(run.triggerRunId);
  log.info({ runId: run.id, triggerRunId: run.triggerRunId }, "run.cancel_requested");
  return { status: 202, data: { runId: run.id, status: "stopping" } };
});
