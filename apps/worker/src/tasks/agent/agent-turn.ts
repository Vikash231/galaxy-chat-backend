import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import { runAgentTurn, type ToolPorts } from "@gx/agent";
import { workerEnv } from "@gx/config";
import { AGENT_TURN_TASK, type ContentBlock, type SafeError } from "@gx/contracts";
import {
  checkpointMessage,
  finalizeMessage,
  getBalance,
  isTerminalRun,
  loadHistory,
  loadRun,
  readError,
  recordStep,
  settleToolCharge,
  startRun,
  transitionRun,
  upsertAssistantMessage,
  upsertInvocation,
} from "@gx/db";
import { LlmError } from "@gx/llm";
import { withContext } from "@gx/observability";
import { toolSpecs } from "@gx/tools";
import { createCoalescer } from "../../adapters/stream-coalescer";
import { createMetaWriter, type MetaWriter } from "../../adapters/run-meta";
import { agentTurns } from "../../queues";
import { getLlm } from "../../services";
import { assistantStream } from "../../streams";
import { magicaRun } from "../tools/magica-run";

export type AgentTurnPayload = { runId: string };

const INTERNAL: SafeError = { code: "internal", message: "Something went wrong while writing this reply.", retryable: true };
const CANCELLED: SafeError = { code: "cancelled", message: "You stopped this reply.", retryable: true };

export const agentTurn = task({
  id: AGENT_TURN_TASK,
  queue: agentTurns,
  maxDuration: 900,
  // One attempt: a blind re-run would call the model again and could start new paid tool calls.
  retry: { maxAttempts: 1 },
  run: async ({ runId }: AgentTurnPayload, { ctx, signal }) => {
    const env = workerEnv();
    const run = await loadRun(runId);
    if (!run || isTerminalRun(run.status)) return { skipped: true };
    if (!(await startRun(runId, ctx.run.id))) return { skipped: true };

    const message = await upsertAssistantMessage(run.chatId, runId);
    const log = withContext({ runId, chatId: run.chatId, userId: run.userId, messageId: message.id, triggerRunId: ctx.run.id });
    // Create the token stream before any metadata is published: clients subscribe once metadata appears,
    // and subscribing to a stream that doesn't exist yet fails with a 400.
    await assistantStream.append({ t: "text", step: 0, d: "" });
    const meta = createMetaWriter();
    meta.set({ status: "thinking", step: 0 });
    const stream = createCoalescer((p) => assistantStream.append(p), (e) => log.warn({ err: e }, "stream.append_failed"));
    let saved: ContentBlock[] = [];
    log.info("run.started");

    try {
      const outcome = await runAgentTurn({
        llm: getLlm(),
        toolSpecs: toolSpecs(),
        tools: toolPorts(run, meta),
        maxSteps: env.AGENT_MAX_STEPS,
        signal,
        history: () => loadHistory(run.chatId, env.AGENT_HISTORY_LIMIT),
        emit: (p) => stream.push(p),
        meta: (patch) => meta.set(patch),
        checkpoint: async (blocks, step, llm) => {
          await stream.flush();
          saved = [...blocks];
          await checkpointMessage(message.id, saved, step);
          if (llm) {
            await recordStep(runId, step, llm.model, llm.usage.promptTokens, llm.usage.completionTokens);
            log.info({ step, model: llm.model, toolCalls: llm.toolCalls.length }, "llm.step");
          }
        },
      });
      await stream.flush();
      await finalizeMessage(message.id, outcome.status === "completed" ? "success" : "failed", outcome.blocks, outcome.error);
      await transitionRun(runId, outcome.status, { error: outcome.error ?? null });
      meta.set({ status: outcome.status === "completed" ? "complete" : "failed", error: outcome.error, label: undefined });
      await meta.flush();
      log.info({ status: outcome.status }, "run.finished");
      return { status: outcome.status };
    } catch (e) {
      const cancelled = signal.aborted;
      const error = cancelled ? CANCELLED : e instanceof LlmError ? e.toSafe() : INTERNAL;
      await stream.flush().catch(() => {});
      // Everything checkpointed so far stays visible; the error explains why the reply stopped.
      await finalizeMessage(message.id, cancelled ? "cancelled" : "failed", saved, error);
      await transitionRun(runId, cancelled ? "cancelled" : "failed", { error });
      meta.set({ status: cancelled ? "cancelled" : "failed", error, label: undefined });
      await meta.flush().catch(() => {});
      log.error({ err: e, code: error.code }, "run.finished");
      if (cancelled) return { status: "cancelled" };
      throw new AbortTaskRunError(error.message);
    }
  },
  // Covers crashes outside the try block (e.g. process killed): never leave a run stuck as active.
  onFailure: async ({ payload }) => {
    const run = await loadRun(payload.runId);
    if (run && !isTerminalRun(run.status)) await transitionRun(run.id, "failed", { error: readError(run) ?? INTERNAL });
  },
});

function toolPorts(run: { id: string; userId: string }, meta: MetaWriter): ToolPorts {
  return {
    balance: () => getBalance(run.userId),
    upsert: async (i) => {
      const row = await upsertInvocation({ runId: run.id, ...i });
      return { id: row.id, status: row.status, output: row.output, creditsMicro: row.creditsMicro, durationMs: row.durationMs, error: readError(row) };
    },
    dispatch: async (_tool, toolInvocationId) => {
      const res = await magicaRun.triggerAndWait({ toolInvocationId }, { idempotencyKey: `magica-run:${toolInvocationId}` });
      if (!res.ok) return { status: "failed", creditsMicro: 0n, error: { code: "tool_task_failed", message: "The tool could not run.", retryable: true } };
      return { ...res.output, creditsMicro: BigInt(res.output.creditsMicro) };
    },
    settle: async (toolInvocationId, creditsMicro) => {
      await settleToolCharge({ userId: run.userId, runId: run.id, toolInvocationId, creditsMicro });
    },
    update: (key, { label, durationMs, ...patch }) => {
      meta.tool(key, { ...patch, ...(durationMs != null && { durationMs }) });
      if (label) meta.set({ label });
    },
  };
}
