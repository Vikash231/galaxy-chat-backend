import type { Prisma } from "@prisma/client";
import { readContent, type MessageView, type PageQuery, type ContentBlock, type SafeError } from "@gx/contracts";
import { prisma } from "./client";
import { decodeCursor, toPage } from "./cursor";
import { errorCols, readError } from "./errors";
import { getOwnedChat } from "./chats";

type MessageRow = {
  id: string;
  role: MessageView["role"];
  status: MessageView["status"];
  runId: string | null;
  checkpointStep: number;
  content: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
  createdAt: Date;
};

export const toMessageView = (m: MessageRow): MessageView => ({
  id: m.id,
  role: m.role,
  status: m.status,
  runId: m.runId,
  checkpointStep: m.checkpointStep,
  content: readContent(m.content),
  error: readError(m),
  createdAt: m.createdAt.toISOString(),
});

/** Newest first; the client reverses each page for display. */
export async function listMessages(userId: string, chatId: string, q: PageQuery) {
  await getOwnedChat(userId, chatId);
  const c = decodeCursor(q.cursor);
  const rows = await prisma.$queryRaw<MessageRow[]>`
    SELECT id, role, status, "runId", "checkpointStep", content, "errorCode", "errorMessage", "errorRetryable", "createdAt"
    FROM "Message"
    WHERE "chatId" = ${chatId}
    AND ("createdAt", id) < (${c.at}, ${c.id})
    ORDER BY "createdAt" DESC, id DESC
    LIMIT ${q.limit + 1}`;
  const page = toPage(rows, q.limit, (r) => ({ at: r.createdAt, id: r.id }));
  return { items: page.items.map(toMessageView), nextCursor: page.nextCursor };
}

/** The last `limit` messages of a chat in chronological order, for the LLM context window. */
export async function loadHistory(chatId: string, limit: number) {
  const rows = await prisma.message.findMany({
    where: { chatId, status: { in: ["success", "failed", "cancelled"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { role: true, content: true },
  });
  return rows.reverse().map((r) => ({ role: r.role, content: readContent(r.content) }));
}

export async function upsertAssistantMessage(chatId: string, runId: string) {
  return prisma.message.upsert({
    where: { runId },
    create: { chatId, runId, role: "assistant", status: "streaming", content: [] },
    update: {},
  });
}

/** Persist everything produced up to `step`; called once per LLM step, never per token. */
export const checkpointMessage = (id: string, content: ContentBlock[], step: number) =>
  prisma.message.update({ where: { id }, data: { content: content as Prisma.InputJsonValue, checkpointStep: step } });

export const finalizeMessage = (
  id: string,
  status: "success" | "failed" | "cancelled",
  content: ContentBlock[],
  error?: SafeError,
) =>
  prisma.message.updateMany({
    where: { id, status: "streaming" },
    data: { status, content: content as Prisma.InputJsonValue, ...errorCols(error) },
  });

/**
 * Save the content of a stopped reply. Unlike finalizeMessage it may overwrite a reply the API already
 * marked cancelled: the worker's copy holds everything saved so far plus the text streamed since.
 */
export const saveCancelledMessage = (id: string, content: ContentBlock[], error: SafeError) =>
  prisma.message.updateMany({
    where: { id, status: { in: ["streaming", "cancelled"] } },
    data: { status: "cancelled", content: content as Prisma.InputJsonValue, ...errorCols(error) },
  });

/** Mark a reply that was still streaming as failed, keeping whatever it saved. */
export const failStreamingReply = (runId: string, error: SafeError) =>
  prisma.message.updateMany({ where: { runId, status: "streaming" }, data: { status: "failed", ...errorCols(error) } });
