import type { ContentBlock, SafeError, ToolStatus } from "@gx/contracts";
import { getTool, parseArgs, type AnyTool } from "@gx/tools";

export type Invocation = { id: string; status: ToolStatus; output: unknown; creditsMicro: bigint; error: SafeError | null };
export type ToolOutcome = { status: "completed" | "failed" | "cancelled"; output?: unknown; creditsMicro: bigint; error?: SafeError };

/** Everything the executor needs from the outside world; the worker implements these with Postgres and Trigger.dev. */
export interface ToolPorts {
  balance(): Promise<bigint>;
  upsert(i: { toolCallId: string; seq: number; name: string; input: unknown; estimateMicro: bigint }): Promise<Invocation>;
  dispatch(tool: AnyTool, toolInvocationId: string): Promise<ToolOutcome>;
  settle(toolInvocationId: string, creditsMicro: bigint): Promise<void>;
  update(key: string, patch: { name: string; seq: number; status: ToolStatus; credits?: string; assetUrl?: string; error?: SafeError; label?: string }): void;
}

export type PendingCall = { key: string; seq: number; name: string; argsJson: string };
export type ExecutedCall = { key: string; blocks: ContentBlock[]; llmContent: string; stop?: SafeError };

const failure = (key: string, error: SafeError, stop = false): ExecutedCall => ({
  key,
  blocks: [{ type: "tool_result", toolCallId: key, status: "failed", error }],
  llmContent: JSON.stringify({ error: error.message }),
  ...(stop && { stop: error }),
});

async function executeOne(ports: ToolPorts, call: PendingCall): Promise<ExecutedCall> {
  const tool = getTool(call.name);
  if (!tool) return failure(call.key, { code: "unknown_tool", message: `There is no tool named "${call.name}".`, retryable: false });

  const parsed = parseArgs(tool, call.argsJson);
  if (!parsed.ok) {
    ports.update(call.key, { name: tool.name, seq: call.seq, status: "failed", error: { code: "invalid_input", message: parsed.message, retryable: false } });
    return failure(call.key, { code: "invalid_input", message: parsed.message, retryable: false });
  }

  const estimate = tool.estimateMicro(parsed.args);
  if ((await ports.balance()) < estimate) {
    const error = { code: "insufficient_credits", message: "You're out of credits for this tool.", retryable: false };
    ports.update(call.key, { name: tool.name, seq: call.seq, status: "failed", error });
    return failure(call.key, error, true);
  }

  const inv = await ports.upsert({ toolCallId: call.key, seq: call.seq, name: tool.name, input: parsed.args, estimateMicro: estimate });
  ports.update(call.key, { name: tool.name, seq: call.seq, status: "running", label: tool.label });

  const outcome: ToolOutcome =
    inv.status === "completed" || inv.status === "failed" || inv.status === "cancelled"
      ? { status: inv.status, output: inv.output, creditsMicro: inv.creditsMicro, error: inv.error ?? undefined }
      : await ports.dispatch(tool, inv.id);

  if (outcome.creditsMicro > 0n) await ports.settle(inv.id, outcome.creditsMicro);

  if (outcome.status !== "completed") {
    const error = outcome.error ?? { code: outcome.status, message: `The tool ${outcome.status}.`, retryable: true };
    ports.update(call.key, { name: tool.name, seq: call.seq, status: outcome.status, error, credits: outcome.creditsMicro.toString() });
    return failure(call.key, error);
  }

  const assets = tool.assets(outcome.output);
  ports.update(call.key, { name: tool.name, seq: call.seq, status: "completed", credits: outcome.creditsMicro.toString(), assetUrl: assets[0]?.url });
  return {
    key: call.key,
    blocks: [
      { type: "tool_result", toolCallId: call.key, status: "completed", output: outcome.output },
      ...assets.map((a) => ({ type: "asset" as const, kind: a.kind, url: a.url, toolCallId: call.key })),
    ],
    llmContent: JSON.stringify(outcome.output),
  };
}

/** Run independent calls in parallel; results come back in call order so rendering and replay are deterministic. */
export const executeTools = (ports: ToolPorts, calls: PendingCall[]) => Promise.all(calls.map((c) => executeOne(ports, c)));
