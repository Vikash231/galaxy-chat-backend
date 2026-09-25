import { queue } from "@trigger.dev/sdk";

const limit = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

/** Agent turns; per-chat ordering comes from concurrencyKey = chatId at trigger time. */
export const agentTurns = queue({ name: "agent-turns", concurrencyLimit: limit("AGENT_QUEUE_CONCURRENCY", 50) });

/** Provider calls, limited separately so a Magica rate limit never starves agent turns. */
export const toolRuns = queue({ name: "tool-runs", concurrencyLimit: limit("TOOL_QUEUE_CONCURRENCY", 10) });
