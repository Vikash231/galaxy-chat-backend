import { AbortTaskRunError, task, wait } from "@trigger.dev/sdk";
import { workerEnv } from "@gx/config";
import type { SafeError } from "@gx/contracts";
import {
  adjustProviderSpend,
  finishInvocation,
  getInvocation,
  isTerminalTool,
  markDispatching,
  markRunning,
  readError,
  releaseDispatch,
  reserveProviderSpend,
  type ToolOutcome,
} from "@gx/db";
import { MagicaError, isMagicaTerminal, type MagicaRun } from "@gx/magica";
import { withContext } from "@gx/observability";
import { getTool, type AnyTool } from "@gx/tools";
import { toolRuns } from "../../queues";
import { getMagica } from "../../services";

/** What the parent turn receives; bigint travels as a string. */
export type ToolOutcomeWire = { status: ToolOutcome["status"]; output?: unknown; creditsMicro: string; durationMs?: number; error?: SafeError };

const PROVIDER = "magica";
const POLL_SECONDS = 5;
const MAX_POLLS = 60;

const safe = (code: string, message: string, retryable: boolean): SafeError => ({ code, message, retryable });

export const magicaRun = task({
  id: "magica-run",
  queue: toolRuns,
  maxDuration: 900,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 10_000 },
  run: async ({ toolInvocationId }: { toolInvocationId: string }, { ctx }): Promise<ToolOutcomeWire> => {
    const log = withContext({ toolInvocationId, triggerRunId: ctx.run.id });
    let inv = await getInvocation(toolInvocationId);
    if (isTerminalTool(inv.status)) return toWire(inv);

    const tool = getTool(inv.name);
    if (!tool) return finish(toolInvocationId, { status: "failed", error: safe("unknown_tool", "This tool is no longer available.", false) });

    const magica = getMagica();
    const live = magica.mode === "live";
    // Created before dispatch because Magica needs its URL; the idempotency key returns the same token on retry.
    const token = await wait.createToken({ timeout: "10m", idempotencyKey: `magica-token:${toolInvocationId}` });

    if (!inv.magicaRunId) {
      // A previous attempt claimed the call but crashed before saving Magica's run id: it may already be billed.
      if (inv.status === "dispatching")
        return finish(toolInvocationId, { status: "failed", error: safe("dispatch_uncertain", "The tool call was interrupted. Retry to run it again.", true) });
      if (live && !(await reserveProviderSpend(PROVIDER, inv.estimateMicro, workerEnv().MAGICA_DAILY_CAP_MICRO)))
        return finish(toolInvocationId, { status: "failed", error: safe("spend_cap", "The tool budget for today is used up.", false) });
      if (!(await markDispatching(toolInvocationId))) throw new Error("tool invocation was claimed concurrently");

      try {
        const { runId } = await magica.run(tool.exec.nodeType, {
          input: tool.exec.toInput(inv.input as never),
          subModelId: tool.exec.subModelId?.(inv.input as never),
          ...(live && { webhook: { url: token.url, events: ["run.completed", "run.failed", "run.canceled"] } }),
        });
        inv = await markRunning(toolInvocationId, runId);
        log.info({ magicaRunId: runId, nodeType: tool.exec.nodeType }, "tool.dispatched");
      } catch (e) {
        if (live) await adjustProviderSpend(PROVIDER, -inv.estimateMicro);
        if (e instanceof MagicaError && e.code === "timeout")
          return finish(toolInvocationId, { status: "failed", error: safe("dispatch_uncertain", "The media service did not answer in time. Retry to run it again.", true) });
        if (e instanceof MagicaError && !e.retryable) return finish(toolInvocationId, { status: "failed", error: e.toSafe() });
        // 429/5xx: Magica did not accept the call, so it is safe to release the claim and let the task retry.
        await releaseDispatch(toolInvocationId);
        throw e;
      }
    }

    const magicaRunId = inv.magicaRunId!;
    let run = await magica.getRun(magicaRunId);
    if (!isMagicaTerminal(run)) {
      // Suspended with no compute until Magica's webhook hits the token URL or the token times out.
      await wait.forToken(token.id);
      run = await magica.getRun(magicaRunId); // the webhook body is never trusted; Magica's API is the source of truth
      for (let i = 0; !isMagicaTerminal(run) && i < MAX_POLLS; i++) {
        await wait.for({ seconds: POLL_SECONDS });
        run = await magica.getRun(magicaRunId);
      }
    }
    if (!isMagicaTerminal(run))
      return finish(toolInvocationId, { status: "failed", error: safe("provider_timeout", "The media service is taking too long. Try again later.", true) });

    return settleProviderRun(toolInvocationId, tool, run, inv.estimateMicro, live);
  },
});

async function settleProviderRun(id: string, tool: AnyTool, run: MagicaRun, estimateMicro: bigint, live: boolean) {
  const creditsMicro = BigInt(Math.round(run.creditUsed));
  if (live) await adjustProviderSpend(PROVIDER, creditsMicro - estimateMicro);

  if (run.status !== "COMPLETED") {
    const status = run.status === "CANCELED" ? "cancelled" : "failed";
    return finish(id, { status, creditsMicro, error: safe("provider_failed", run.userMessage ?? "The media service could not complete this request.", true) });
  }
  try {
    return finish(id, { status: "completed", output: tool.exec.fromOutput(run.output), creditsMicro });
  } catch {
    // Charged by the provider but the output did not match the contract: record the cost, surface a safe error.
    return finish(id, { status: "failed", creditsMicro, error: safe("provider_output", "The media service returned an unexpected result.", false) });
  }
}

async function finish(id: string, outcome: ToolOutcome): Promise<ToolOutcomeWire> {
  return toWire(await finishInvocation(id, outcome));
}

type InvocationRow = Awaited<ReturnType<typeof getInvocation>>;

function toWire(inv: InvocationRow): ToolOutcomeWire {
  if (!isTerminalTool(inv.status)) throw new AbortTaskRunError(`invocation ${inv.id} not terminal: ${inv.status}`);
  return {
    status: inv.status as ToolOutcome["status"],
    output: inv.output ?? undefined,
    creditsMicro: inv.creditsMicro.toString(),
    durationMs: inv.durationMs ?? undefined,
    error: readError(inv) ?? undefined,
  };
}
