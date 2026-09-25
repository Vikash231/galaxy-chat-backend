import { randomUUID } from "node:crypto";
import { MagicaError, errorFromStatus } from "./errors";
import { fixtureRun } from "./fixtures";
import { MagicaRun, type RunRequest } from "./types";

export type MagicaClientOptions = {
  baseUrl: string;
  apiKey: string;
  mode: "fixture" | "live";
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export interface MagicaClient {
  readonly mode: "fixture" | "live";
  run(nodeType: string, req: RunRequest): Promise<{ runId: string }>;
  getRun(runId: string): Promise<MagicaRun>;
}

export function createMagicaClient(opts: MagicaClientOptions): MagicaClient {
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await (opts.fetch ?? globalThis.fetch)(new URL(path, opts.baseUrl), {
        method,
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      throw new MagicaError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "provider_error", null, (e as Error).message);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) throw errorFromStatus(res.status, json as { message?: string; traceId?: string });
    return json as T;
  }

  if (opts.mode === "fixture") {
    return {
      mode: "fixture",
      // The node type lives in the id so a restarted task can still resolve the fixture.
      run: async (nodeType) => ({ runId: `fixture.${nodeType}.${randomUUID()}` }),
      getRun: async (runId) => fixtureRun(runId, runId.split(".")[1] ?? "unknown"),
    };
  }

  return {
    mode: "live",
    async run(nodeType, req) {
      const out = await call<{ runId?: string }>("POST", `/v1/nodes/${encodeURIComponent(nodeType)}/run`, req);
      if (!out.runId) throw new MagicaError("provider_error", 202, "response had no runId");
      return { runId: out.runId };
    },
    async getRun(runId) {
      const raw = await call<unknown>("GET", `/v1/nodes/runs/${encodeURIComponent(runId)}`);
      const parsed = MagicaRun.safeParse(raw);
      if (!parsed.success) throw new MagicaError("provider_error", 200, "unexpected run payload");
      return parsed.data;
    },
  };
}
