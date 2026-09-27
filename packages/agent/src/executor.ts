import type { ContentBlock, SafeError, ToolStatus, WaitpointRequest } from "@gx/contracts";
import { getTool, parseArgs, type AnyTool, type AskResult, type Asset } from "@gx/tools";
import { withRefs } from "./files";
import { capToolContent } from "./history";

export type Invocation = { id: string; status: ToolStatus; output: unknown; creditsMicro: bigint; durationMs?: number | null; error: SafeError | null };
export type ToolOutcome = { status: "completed" | "failed" | "cancelled"; output?: unknown; creditsMicro: bigint; durationMs?: number; error?: SafeError };

/** Everything the executor needs from the outside world; the worker implements these with Postgres and Trigger.dev. */
export interface ToolPorts {
  balance(): Promise<bigint>;
  upsert(i: { toolCallId: string; seq: number; name: string; input: unknown; estimateMicro: bigint }): Promise<Invocation>;
  dispatch(tool: AnyTool, toolInvocationId: string): Promise<ToolOutcome>;
  /** Run a free, in-process tool (e.g. load_skill) and record its outcome. */
  runLocal(tool: AnyTool, args: unknown, toolInvocationId: string, ctx: LocalRunCtx): Promise<ToolOutcome>;
  /** Pause the run and ask the user; resolves when they answer or the question expires. Absent = nothing asks (tests). */
  ask?(key: string, request: WaitpointRequest): Promise<AskResult>;
  /** Run-level approval state, read from Postgres so it survives a suspend. Absent = no approvals. */
  approvals?: Approvals;
  settle(toolInvocationId: string, creditsMicro: bigint): Promise<void>;
  /** Name new result files (img_4, …) and record them for the chat. */
  reserveFileRefs(files: (Asset & { tool: string })[]): Promise<string[]>;
  update(key: string, patch: { name: string; seq: number; status: ToolStatus; credits?: string; durationMs?: number; assetUrl?: string; assetKind?: Asset["kind"]; error?: SafeError; label?: string }): void;
}

/** What a running local tool may use from its call. */
export type LocalRunCtx = { toolCallKey: string; files: FileContext };

export interface Approvals {
  planMode: boolean;
  /** Ask before a step whose paid calls cost at least this much (outside plan mode). */
  creditThresholdMicro: bigint;
  /** The most this run may spend without asking again; null = no plan or cost approved yet. */
  approvedCapMicro(): Promise<bigint | null>;
  /** Estimated spend so far in this run. */
  spentMicro(): Promise<bigint>;
}

export type PendingCall = { key: string; seq: number; name: string; argsJson: string };
/** `stop` fails the turn; `end` finishes it normally with a note (the user declined or never answered). */
export type ExecutedCall = { key: string; blocks: ContentBlock[]; llmContent: string; creditsMicro: bigint; stop?: SafeError; end?: string };

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

type Prepared = { call: PendingCall; tool: AnyTool; args: unknown; estimate: bigint };

const isPaid = (p: Prepared) => p.tool.exec.kind === "magica";

/** Check one call before anything is asked or spent: known tool, valid arguments, enough credits. */
async function prepare(ports: ToolPorts, call: PendingCall, { files, aliases, durations }: FileContext): Promise<Prepared | ExecutedCall> {
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
  return { call, tool, args: parsed.args, estimate };
}

const rejected = (ports: ToolPorts, p: Prepared, error: SafeError): ExecutedCall => {
  ports.update(p.call.key, { name: p.tool.name, seq: p.call.seq, status: "failed", error });
  return failure(p.call.key, error);
};

async function executeOne(ports: ToolPorts, { call, tool, args, estimate }: Prepared, fileCtx: FileContext): Promise<ExecutedCall> {
  const { files, durations } = fileCtx;
  const inv = await ports.upsert({ toolCallId: call.key, seq: call.seq, name: tool.name, input: args, estimateMicro: estimate });
  ports.update(call.key, { name: tool.name, seq: call.seq, status: "running", label: tool.label });

  const outcome: ToolOutcome =
    inv.status === "completed" || inv.status === "failed" || inv.status === "cancelled"
      ? { status: inv.status, output: inv.output, creditsMicro: inv.creditsMicro, durationMs: inv.durationMs ?? undefined, error: inv.error ?? undefined }
      : tool.exec.kind === "local"
        ? await ports.runLocal(tool, args, inv.id, { toolCallKey: call.key, files: fileCtx })
        : await ports.dispatch(tool, inv.id);

  if (outcome.creditsMicro > 0n) await ports.settle(inv.id, outcome.creditsMicro);

  if (outcome.status !== "completed") {
    const error = outcome.error ?? { code: outcome.status, message: `The tool ${outcome.status}.`, retryable: true };
    ports.update(call.key, { name: tool.name, seq: call.seq, status: outcome.status, error, credits: outcome.creditsMicro.toString(), durationMs: outcome.durationMs });
    return failure(call.key, error, false, outcome);
  }

  const assets = tool.assets(outcome.output);
  const refs = await ports.reserveFileRefs(assets.map((a) => ({ ...a, tool: tool.name })));
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
    llmContent: capToolContent(JSON.stringify(withRefs(outcome.output, new Map(assets.map((a, i) => [a.url, refs[i]!]))))),
    creditsMicro: outcome.creditsMicro,
    ...(tool.endsTurn && { end: tool.endsTurn(outcome.output) }),
  };
}

const SKIPPED: SafeError = { code: "skipped", message: "Skipped: the user was asked a question first. Repeat this call after the answer if it is still needed.", retryable: false };
const PLAN_FIRST: SafeError = {
  code: "plan_required",
  message: 'Plan mode is on. Call propose_plan and wait for the user\'s approval before using this tool. Send steps as a list of objects, e.g. {"summary":"...","steps":[{"text":"...","tool":"gpt_image_2","args":{"prompt":"..."}}]}.',
  retryable: false,
};
const DECLINED: SafeError = { code: "declined", message: "The user declined the cost. Do not retry this call; say what you could do instead.", retryable: false };
const NO_ANSWER_NOTE = "I didn't get an answer about the cost, so I stopped here. Nothing was spent. Send a message when you're ready to continue.";

/** Whether this step's paid calls need the user's OK first, and the cumulative cost to show if so. */
async function costApproval(ports: ToolPorts, paid: Prepared[]): Promise<{ stepMicro: bigint; totalMicro: bigint } | "plan_first" | null> {
  const a = ports.approvals;
  if (!a || !paid.length) return null;
  const stepMicro = paid.reduce((n, p) => n + p.estimate, 0n);
  if (!a.planMode) return stepMicro >= a.creditThresholdMicro ? { stepMicro, totalMicro: (await a.spentMicro()) + stepMicro } : null;
  const cap = await a.approvedCapMicro();
  if (cap === null) return "plan_first";
  const totalMicro = (await a.spentMicro()) + stepMicro;
  return totalMicro > cap ? { stepMicro, totalMicro } : null;
}

/**
 * Run one step's calls. Every call is checked first; a question to the user runs alone; paid calls wait for
 * plan or cost approval; the rest run in parallel. Results come back in call order so replay is deterministic.
 */
export async function executeTools(ports: ToolPorts, calls: PendingCall[], ctx: FileContext = { files: new Map(), aliases: new Map(), durations: new Map() }): Promise<ExecutedCall[]> {
  const checked = await Promise.all(calls.map((c) => prepare(ports, c, ctx)));
  const results = new Map<string, ExecutedCall>();
  const ready: Prepared[] = [];
  for (const c of checked) "tool" in c ? ready.push(c) : results.set(c.key, c);

  let toRun = ready;
  const question = ready.find((p) => p.tool.interactive);
  if (question) {
    // One question at a time: the model repeats the other calls after the answer.
    for (const p of ready) if (p !== question) results.set(p.call.key, rejected(ports, p, SKIPPED));
    toRun = [question];
  } else {
    const paid = ready.filter(isPaid);
    const need = await costApproval(ports, paid);
    if (need === "plan_first") {
      for (const p of paid) results.set(p.call.key, rejected(ports, p, PLAN_FIRST));
      toRun = ready.filter((p) => !isPaid(p));
    } else if (need && ports.ask) {
      const step = Math.floor(paid[0]!.call.seq / 100);
      const res = await ports.ask(`credit:${step}`, {
        kind: "credit",
        tools: paid.map((p) => ({ name: p.tool.name, estimateMicro: Number(p.estimate) })),
        stepMicro: Number(need.stepMicro),
        totalMicro: Number(need.totalMicro),
      });
      const approved = res.status === "answered" && "approve" in res.answer && res.answer.approve;
      if (!approved) {
        paid.forEach((p, i) => {
          const r = rejected(ports, p, DECLINED);
          results.set(p.call.key, res.status === "answered" || i > 0 ? r : { ...r, end: NO_ANSWER_NOTE });
        });
        toRun = ready.filter((p) => !isPaid(p));
      }
    }
  }

  for (const r of await Promise.all(toRun.map((p) => executeOne(ports, p, ctx)))) results.set(r.key, r);
  return calls.map((c) => results.get(c.key)!);
}
