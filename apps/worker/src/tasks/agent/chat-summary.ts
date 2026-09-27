import { task } from "@trigger.dev/sdk";
import { acceptSummary, estimateTokens, keepTokens, planSummary, SUMMARY_MAX_TOKENS, summaryMessages } from "@gx/agent";
import { workerEnv } from "@gx/config";
import { loadChatContext, saveSummary } from "@gx/db";
import { withContext } from "@gx/observability";
import { summaries } from "../../queues";
import { getLlm } from "../../services";

export type ChatSummaryPayload = { chatId: string };

export const summaryLimits = () => {
  const env = workerEnv();
  return { limitTokens: env.SUMMARY_LIMIT_TOKENS, limitMessages: env.SUMMARY_LIMIT_MESSAGES, keepMessages: env.SUMMARY_KEEP_MESSAGES, targetTokens: env.SUMMARY_TARGET_TOKENS };
};

/**
 * Fold a chat's older messages into its running summary, keeping the newest ones word for word.
 * Safe to retry: it makes no paid calls, and the same cut point saves once.
 */
export const chatSummary = task({
  id: "chat-summary",
  queue: summaries,
  maxDuration: 300,
  retry: { maxAttempts: 3 },
  run: async ({ chatId }: ChatSummaryPayload) => {
    const log = withContext({ chatId });
    const limits = summaryLimits();
    const chat = await loadChatContext(chatId, workerEnv().AGENT_HISTORY_LIMIT);
    const { fold, keep } = planSummary(chat.messages, { keepMessages: limits.keepMessages, keepTokens: keepTokens(limits) });
    const last = fold.at(-1);
    if (!last?.id || !last.createdAt) return { skipped: true };

    const res = await getLlm().streamStep({ messages: summaryMessages(chat.summary, fold), tools: [], maxTokens: SUMMARY_MAX_TOKENS }, () => {});
    // Nothing is saved on failure: the previous summary and every message after it stay in use, and the job retries.
    const content = acceptSummary(res);
    if (!content) throw new Error(`The summary was empty or cut off (finish: ${res.finishReason}).`);
    await saveSummary({ chatId, content, upToMessageId: last.id, upToCreatedAt: last.createdAt, tokens: estimateTokens(content), model: res.model });
    log.info({ folded: fold.length, kept: keep.length, upToMessageId: last.id, model: res.model }, "chat.summarised");
    return { folded: fold.length, kept: keep.length };
  },
});
