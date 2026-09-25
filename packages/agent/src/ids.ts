import { createHash } from "node:crypto";

/** Durable key for a tool call within a run; provider ids repeat across steps, so the step is part of it. */
export const toolCallKey = (step: number, providerId: string) => `${step}:${providerId}`;

/** The id shown to the LLM: 9 alphanumerics, the strictest format any routed provider accepts. */
export const llmCallId = (key: string) => createHash("sha1").update(key).digest("hex").slice(0, 9);
