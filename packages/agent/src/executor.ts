import type { ContentBlock, SafeError, ToolStatus } from "@gx/contracts";
import { getTool, parseArgs, type AnyTool, type Asset } from "@gx/tools";
import { withRefs } from "./files";

export type Invocation = { id: string; status: ToolStatus; output: unknown; creditsMicro: bigint; durationMs?: number | null; error: SafeError | null };
export type ToolOutcome = { status: "completed" | "failed" | "cancelled"; output?: unknown; creditsMicro: bigint; durationMs?: number; error?: SafeError };

/** Everything the executor needs from the outside world; the worker implements these with Postgres and Trigger.dev. */
export interface ToolPorts {
  balance(): Promise<bigint>;
  upsert(i: { toolCallId: string; seq: number; name: string; input: unknown; estimateMicro: bigint }): Promise<Invocation>;
  dispatch(tool: AnyTool, toolInvocationId: string): Promise<ToolOutcome>;
  settle(toolInvocationId: string, creditsMicro: bigint): Promise<void>;
  /** Reserve chat-unique names (img_4, …) for new result files. */
  reserveFileRefs(kinds: ("image" | "video" | "audio")[]): Promise<string[]>;
  update(key: string, patch: { name: string; seq: number; status: ToolStatus; credits?: string; durationMs?: number; assetUrl?: string; assetKind?: Asset["kind"]; error?: SafeError; label?: string }): void;
}

export type PendingCall = { key: string; seq: number; name: string; argsJson: string };
export type ExecutedCall = { key: string; blocks: ContentBlock[]; llmContent: string; creditsMicro: bigint; stop?: SafeError };

const failure = (key: string, error: SafeError, stop = false, cost?: Pick<ToolOutcome, "creditsMicro" | "durationMs">): ExecutedCall => ({
  key,
  blocks: [{ type: "tool_result", toolCallId: key, status: "failed", error, ...costFields(cost) }],
  llmContent: JSON.stringify({ error: error.message }),
  creditsMicro: cost?.creditsMicro ?? 0n,
  ...(stop && { stop: error }),
});

const costFields = (c?: Pick<ToolOutcome, "creditsMicro" | "durationMs">) => ({
  ...(c && { creditsMicro: Number(c.creditsMicro) }),
  ...(c?.durationMs != null && { durationMs: c.durationMs }),
});

/** Name → URL for every file the model may refer to; results from this turn are added as they complete. */
export type FileMap = Map<string, string>;
/** URL → length in seconds, for files whose length is known. */
export type DurationMap = Map<string, number>;
/** What tool calls may use to name files: short names, uploaded names, and known lengths. */
export type FileContext = { files: FileMap; aliases: ReadonlyMap<string, string>; durations: DurationMap };

async function executeOne(ports: ToolPorts, call: PendingCall, { files, aliases, durations }: FileContext): Promise<ExecutedCall> {
  const tool = getTool(call.name);
  if (!tool) return failure(call.key, { code: "unknown_tool", message: `There is no tool named "${call.name}".`, retryable: false });

  const parsed = parseArgs(tool, call.argsJson, files, aliases);
  if (!parsed.ok) {
    ports.update(call.key, { name: tool.name, seq: call.seq, status: "failed", error: { code: "invalid_input", message: parsed.message, retryable: false } });
    return failure(call.key, { code: "invalid_input", message: parsed.message, retryable: false });
  }

  const estimate = tool.estimateMicro(parsed.args, { durationSec: (url) => durations.get(url) });
  if ((await ports.balance()) < estimate) {
    const error = { code: "insufficient_credits", message: "You're out of credits for this tool.", retryable: false };
    ports.update(call.key, { name: tool.name, seq: call.seq, status: "failed", error });
    return failure(call.key, error, true);
  }

  const inv = await ports.upsert({ toolCallId: call.key, seq: call.seq, name: tool.name, input: parsed.args, estimateMicro: estimate });
  ports.update(call.key, { name: tool.name, seq: call.seq, status: "running", label: tool.label });

  const outcome: ToolOutcome =
    inv.status === "completed" || inv.status === "failed" || inv.status === "cancelled"
      ? { status: inv.status, output: inv.output, creditsMicro: inv.creditsMicro, durationMs: inv.durationMs ?? undefined, error: inv.error ?? undefined }
      : await ports.dispatch(tool, inv.id);

  if (outcome.creditsMicro > 0n) await ports.settle(inv.id, outcome.creditsMicro);

  if (outcome.status !== "completed") {
    const error = outcome.error ?? { code: outcome.status, message: `The tool ${outcome.status}.`, retryable: true };
    ports.update(call.key, { name: tool.name, seq: call.seq, status: outcome.status, error, credits: outcome.creditsMicro.toString(), durationMs: outcome.durationMs });
    return failure(call.key, error, false, outcome);
  }

  const assets = tool.assets(outcome.output);
  const refs = await ports.reserveFileRefs(assets.map((a) => a.kind));
  assets.forEach((a, i) => {
    files.set(refs[i]!, a.url);
    if (a.durationSec != null) durations.set(a.url, a.durationSec);
  });
  ports.update(call.key, { name: tool.name, seq: call.seq, status: "completed", credits: outcome.creditsMicro.toString(), durationMs: outcome.durationMs, assetUrl: assets[0]?.url, assetKind: assets[0]?.kind });
  return {
    key: call.key,
    blocks: [
      { type: "tool_result", toolCallId: call.key, status: "completed", output: outcome.output, ...costFields(outcome) },
      ...assets.map((a, i) => ({ type: "asset" as const, kind: a.kind, url: a.url, toolCallId: call.key, ref: refs[i], ...(a.durationSec != null && { durationSec: a.durationSec }) })),
    ],
    llmContent: JSON.stringify(withRefs(outcome.output, new Map(assets.map((a, i) => [a.url, refs[i]!])))),
    creditsMicro: outcome.creditsMicro,
  };
}

/** Run independent calls in parallel; results come back in call order so rendering and replay are deterministic. */
export const executeTools = (ports: ToolPorts, calls: PendingCall[], ctx: FileContext = { files: new Map(), aliases: new Map(), durations: new Map() }) =>
  Promise.all(calls.map((c) => executeOne(ports, c, ctx)));
