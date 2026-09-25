import { AppError, RunParams } from "@gx/contracts";
import { getOwnedRun } from "@gx/db";
import { withRoute } from "../../../../../../http/with-route";
import { mintRunToken } from "../../../../../../services/realtime";

export const POST = withRoute({ params: RunParams }, async ({ user, params }) => {
  const run = await getOwnedRun(user.id, params.runId);
  if (!run.triggerRunId) throw new AppError("run_not_dispatched", "This reply never started.");
  return { data: await mintRunToken(run.triggerRunId) };
});
