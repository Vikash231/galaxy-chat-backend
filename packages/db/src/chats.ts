import { AppError, type ChatView, type PageQuery, ACTIVE_RUN_STATUSES } from "@gx/contracts";
import { prisma } from "./client";
import { decodeCursor, toPage } from "./cursor";

type ChatRow = { id: string; title: string; pinned: boolean; createdAt: Date; updatedAt: Date };

export const toChatView = (c: ChatRow): ChatView => ({
  id: c.id,
  title: c.title,
  pinned: c.pinned,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export const createChat = (userId: string, title?: string) =>
  prisma.chat.create({ data: { userId, ...(title && { title }) } }).then(toChatView);

/** Ownership is part of the query; a chat owned by someone else is indistinguishable from a missing one. */
export async function getOwnedChat(userId: string, chatId: string) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId, deletedAt: null } });
  if (!chat) throw new AppError("not_found", "Chat not found.");
  return chat;
}

export async function listChats(userId: string, q: PageQuery) {
  const c = decodeCursor(q.cursor);
  const rows = await prisma.$queryRaw<ChatRow[]>`
    SELECT id, title, pinned, "createdAt", "updatedAt" FROM "Chat"
    WHERE "userId" = ${userId} AND "deletedAt" IS NULL
    AND ("updatedAt", id) < (${c.at}, ${c.id})
    ORDER BY "updatedAt" DESC, id DESC
    LIMIT ${q.limit + 1}`;
  const page = toPage(rows, q.limit, (r) => ({ at: r.updatedAt, id: r.id }));
  return { items: page.items.map(toChatView), nextCursor: page.nextCursor };
}

export async function getChatDetail(userId: string, chatId: string) {
  const chat = await getOwnedChat(userId, chatId);
  const active = await prisma.agentRun.findFirst({
    where: { chatId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true, status: true },
  });
  return { chat: toChatView(chat), activeRun: active ? { runId: active.id, status: active.status } : null };
}
