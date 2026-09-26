import { wait } from "@trigger.dev/sdk";
import { workerEnv } from "@gx/config";
import { WaitpointAnswer, type WaitpointRequest } from "@gx/contracts";
import { expireWaitpoint, getWaitpoint, setWaitpointToken, toWaitpointView, transitionRun, upsertWaitpoint } from "@gx/db";
import { withContext, type Logger } from "@gx/observability";
import type { AskResult } from "@gx/tools";
import type { MetaWriter } from "./run-meta";

type Row = Awaited<ReturnType<typeof getWaitpoint>>;

const result = (w: Row): AskResult => {
  if (w.status === "answered") return { status: "answered", answer: WaitpointAnswer.parse(w.answer) };
  return { status: w.status === "expired" ? "expired" : "cancelled" };
};

/**
 * Ask the user and suspend the run until they answer. Postgres decides the outcome: after the token wakes
 * the run (answer or timeout) the row is read again, so an answer that lands at expiry is not lost.
 */
export function createAsk(runId: string, meta: MetaWriter, log: Logger) {
  return async (key: string, request: WaitpointRequest): Promise<AskResult> => {
    const ttl = workerEnv().WAITPOINT_TTL_SECONDS;
    const row = await upsertWaitpoint({ runId, key, request, expiresAt: new Date(Date.now() + ttl * 1000) });
    if (row.status === "pending" && row.expiresAt <= new Date()) await expireWaitpoint(row.id);
    if ((await getWaitpoint(row.id)).status !== "pending") return result(await getWaitpoint(row.id));

    const token = await wait.createToken({ timeout: `${ttl}s`, idempotencyKey: `waitpoint:${row.id}` });
    await setWaitpointToken(row.id, token.id);
    const wlog = withContext({ runId, waitpointTokenId: token.id }, log);

    // The user may have answered before the token existed; then there is nothing to wait for.
    const fresh = await getWaitpoint(row.id);
    if (fresh.status === "pending") {
      await transitionRun(runId, "waiting");
      meta.set({ status: "waiting", waitpoint: toWaitpointView(fresh) });
      await meta.flush();
      wlog.info({ waitpointId: row.id, kind: request.kind, expiresAt: fresh.expiresAt }, "waitpoint.waiting");
      await wait.forToken(token.id); // wakes on the answer or the timeout; both are read from Postgres below
    }

    let done = await getWaitpoint(row.id);
    if (done.status === "pending" && (await expireWaitpoint(row.id))) wlog.info({ waitpointId: row.id }, "waitpoint.expired");
    done = await getWaitpoint(row.id);
    if (done.status === "answered") wlog.info({ waitpointId: row.id }, "waitpoint.answered");

    await transitionRun(runId, "running");
    meta.set({ status: "working", waitpoint: undefined });
    return result(done);
  };
}
