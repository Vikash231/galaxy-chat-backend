import { AppError, type ChatListQuery, type ChatView, type UpdateChatBody, ACTIVE_RUN_STATUSES } from "@gx/contracts";
import { prisma } from "./client";
import { decodeCursor, toPage } from "./cursor";
import { pendingWaitpoint, toWaitpointView } from "./waitpoints";

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

/** Escape LIKE wildcards so a search for "50%" matches the text, not everything. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const PINNED_LIMIT = 50;

/** Search by title across all chats, or list pinned chats, or (default) the unpinned ones, newest activity first. */
export async function listChats(userId: string, q: ChatListQuery) {
  if (q.q) {
    const c = decodeCursor(q.cursor);
    const rows = await prisma.$queryRaw<ChatRow[]>`
      SELECT id, title, pinned, "createdAt", "updatedAt" FROM "Chat"
      WHERE "userId" = ${userId} AND "deletedAt" IS NULL AND title ILIKE ${likePattern(q.q)} ESCAPE '\\'
      AND ("updatedAt", id) < (${c.at}, ${c.id})
      ORDER BY "updatedAt" DESC, id DESC
      LIMIT ${q.limit + 1}`;
    const page = toPage(rows, q.limit, (r) => ({ at: r.updatedAt, id: r.id }));
    return { items: page.items.map(toChatView), nextCursor: page.nextCursor };
  }
  if (q.pinned === "true") {
    const rows = await prisma.chat.findMany({ where: { userId, deletedAt: null, pinned: true }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: PINNED_LIMIT });
    return { items: rows.map(toChatView), nextCursor: null };
  }
  const c = decodeCursor(q.cursor);
  const rows = await prisma.$queryRaw<ChatRow[]>`
    SELECT id, title, pinned, "createdAt", "updatedAt" FROM "Chat"
    WHERE "userId" = ${userId} AND "deletedAt" IS NULL AND pinned = false
    AND ("updatedAt", id) < (${c.at}, ${c.id})
    ORDER BY "updatedAt" DESC, id DESC
    LIMIT ${q.limit + 1}`;
  const page = toPage(rows, q.limit, (r) => ({ at: r.updatedAt, id: r.id }));
  return { items: page.items.map(toChatView), nextCursor: page.nextCursor };
}

/** Pinned chats beyond this would fall out of both lists, so pinning stops here. */
export const MAX_PINNED = PINNED_LIMIT;

/**
 * Pin or rename a chat. Raw SQL on purpose: Prisma would stamp the activity time, which would reorder the
 * recent list, and writing back an earlier read of it could undo a message sent in between.
 */
export async function updateChat(userId: string, chatId: string, patch: UpdateChatBody) {
  const chat = await getOwnedChat(userId, chatId);
  if (patch.pinned === true && !chat.pinned && (await prisma.chat.count({ where: { userId, pinned: true, deletedAt: null } })) >= MAX_PINNED)
    throw new AppError("validation_failed", `You can pin up to ${MAX_PINNED} chats. Unpin one first.`);
  const rows = await prisma.$queryRaw<ChatRow[]>`
    UPDATE "Chat"
    SET pinned = COALESCE(${patch.pinned ?? null}::boolean, pinned), title = COALESCE(${patch.title?.trim() ?? null}::text, title)
    WHERE id = ${chat.id} AND "deletedAt" IS NULL
    RETURNING id, title, pinned, "createdAt", "updatedAt"`;
  if (!rows[0]) throw new AppError("not_found", "Chat not found.");
  return toChatView(rows[0]);
}

/**
 * Hide a chat (kept in the database for the credit ledger). The chat row is locked first, and sending a message
 * locks the same row, so the two take turns: a send that won sees its run here and blocks the delete, and a
 * delete that won makes the send fail. Without the lock, a run committed a moment earlier could be missed.
 */
export async function deleteChat(userId: string, chatId: string) {
  const chat = await getOwnedChat(userId, chatId);
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Chat" WHERE id = ${chat.id} AND "deletedAt" IS NULL FOR UPDATE`;
    if (!locked[0]) throw new AppError("not_found", "Chat not found.");
    const active = await tx.agentRun.findFirst({ where: { chatId: chat.id, status: { in: [...ACTIVE_RUN_STATUSES] } }, select: { id: true } });
    if (active) throw new AppError("run_active", "A reply is still running in this chat. Stop it first.", { activeRunId: active.id });
    await tx.chat.update({ where: { id: chat.id }, data: { deletedAt: new Date(), pinned: false } });
  });
  return { id: chat.id };
}

export async function getChatDetail(userId: string, chatId: string) {
  const chat = await getOwnedChat(userId, chatId);
  const active = await prisma.agentRun.findFirst({
    where: { chatId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true, status: true },
  });
  const waiting = active ? await pendingWaitpoint(active.id) : null;
  return { chat: toChatView(chat), activeRun: active ? { runId: active.id, status: active.status, waitpoint: waiting ? toWaitpointView(waiting) : null } : null };
}
