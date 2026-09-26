import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import { runAgentTurn, type ToolPorts } from "@gx/agent";
import { workerEnv } from "@gx/config";
import { AGENT_TURN_TASK, type ContentBlock, type SafeError, type WaitpointRequest } from "@gx/contracts";
import {
  approvedCapMicro,
  checkpointMessage,
  finalizeMessage,
  finishInvocation,
  getBalance,
  isTerminalRun,
  loadHistory,
  loadRun,
  markDispatching,
  prisma,
  readError,
  reserveFileRefs,
  recordRunSkill,
  saveCancelledMessage,
  spentEstimateMicro,
  recordStep,
  settleToolCharge,
  startRun,
  transitionRun,
  upsertAssistantMessage,
  upsertInvocation,
} from "@gx/db";
import { LlmError } from "@gx/llm";
import { withContext, type Logger } from "@gx/observability";
import { skillIndex, toolSpecs, ToolRunError, type AnyTool, type AskResult, type FileLookup, type LocalExec } from "@gx/tools";
import { createCoalescer } from "../../adapters/stream-coalescer";
import { createMetaWriter, type MetaWriter } from "../../adapters/run-meta";
import { createAsk } from "../../adapters/waitpoint";
import { agentTurns } from "../../queues";
import { getLlm, getSkills } from "../../services";
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
      const skills = getSkills(); // also installs the skill tools, so it runs before toolSpecs()
      const outcome = await runAgentTurn({
        llm: getLlm(),
        toolSpecs: toolSpecs(),
        skills: skillIndex(skills),
        planMode: run.planMode,
        tools: toolPorts(run, meta, log),
        maxSteps: env.AGENT_MAX_STEPS,
        signal,
        history: () => loadHistory(run.chatId, env.AGENT_HISTORY_LIMIT),
        emit: (p) => stream.push(p),
        meta: (patch) => meta.set(patch),
        checkpoint: async (blocks, step, llm) => {
          // Set first: after a Stop the stream flush can throw, and the catch below saves `saved`.
          saved = [...blocks];
          await stream.flush();
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
      // A stop is usually already recorded by the API; this adds the text streamed before it landed.
      if (cancelled) await saveCancelledMessage(message.id, saved, error);
      else await finalizeMessage(message.id, "failed", saved, error);
      await transitionRun(runId, cancelled ? "cancelled" : "failed", { error });
      meta.set({ status: cancelled ? "cancelled" : "failed", error, label: undefined });
      await meta.flush().catch(() => {});
      log.error({ err: e, code: error.code }, "run.finished");
      if (cancelled) return { status: "cancelled" };
      throw new AbortTaskRunError(error.message);
    }
  },
  // A stop while the model streams: give run() up to 30 s to save the partial reply (Trigger.dev's limit).
  // A stop while suspended on a tool never reaches here; the API's cancel route covers that case.
  onCancel: async ({ runPromise }) => {
    await runPromise.catch(() => {});
  },
  // Covers crashes outside the try block (e.g. process killed): never leave a run stuck as active.
  onFailure: async ({ payload }) => {
    const run = await loadRun(payload.runId);
    if (run && !isTerminalRun(run.status)) await transitionRun(run.id, "failed", { error: readError(run) ?? INTERNAL });
  },
});

function toolPorts(run: { id: string; userId: string; chatId: string; planMode: boolean }, meta: MetaWriter, log: Logger): ToolPorts {
  const ask = createAsk(run.id, meta, log);
  return {
    ask,
    approvals: {
      planMode: run.planMode,
      creditThresholdMicro: workerEnv().CREDIT_APPROVAL_MICRO,
      approvedCapMicro: () => approvedCapMicro(run.id),
      spentMicro: () => spentEstimateMicro(run.id),
    },
    reserveFileRefs: (kinds) => reserveFileRefs(prisma, run.chatId, kinds),
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
    runLocal: async (tool, args, toolInvocationId, ctx) => {
      await markDispatching(toolInvocationId); // stamps startedAt so the duration is recorded
      const inv = await finishInvocation(toolInvocationId, await runLocalTool(tool, args, run.id, log, ctx.files, (req) => ask(ctx.toolCallKey, req)));
      return { status: inv.status as "completed" | "failed", output: inv.output ?? undefined, creditsMicro: 0n, durationMs: inv.durationMs ?? undefined, error: readError(inv) ?? undefined };
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

/** Run an in-process tool; its output is checked against the tool's own output schema. */
async function runLocalTool(tool: AnyTool, args: unknown, runId: string, log: Logger, files: FileLookup, ask: (req: WaitpointRequest) => Promise<AskResult>) {
  try {
    const exec = tool.exec as LocalExec<never, unknown>;
    const output = tool.output.parse(
      await exec.run(args as never, {
        recordSkill: async (name, contentHash, content) => {
          const rec = await recordRunSkill(runId, name, contentHash, content);
          log.info({ skill: name, contentHash: rec.contentHash, first: rec.first }, "skill.loaded");
          return rec;
        },
        ask,
        files,
      }),
    );
    return { status: "completed" as const, output };
  } catch (e) {
    if (e instanceof ToolRunError) return { status: "failed" as const, error: { code: "invalid_input", message: e.message, retryable: false } };
    log.error({ err: e, tool: tool.name }, "tool.local_failed");
    return { status: "failed" as const, error: { code: "tool_failed", message: "The tool could not run.", retryable: true } };
  }
}
