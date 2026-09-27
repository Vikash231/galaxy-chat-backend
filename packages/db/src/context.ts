import { readContent, type ContentBlock } from "@gx/contracts";
import { prisma, type Tx } from "./client";
import { reserveFileRefs } from "./attachments";

type FileKind = "image" | "video" | "audio";
export type NewChatFile = { kind: FileKind; url: string; name?: string | null; tool?: string | null; durationSec?: number | null };

/** Record named files so the agent can use them after their message is trimmed; a repeat is ignored. */
export const addChatFiles = (db: Tx, chatId: string, files: (NewChatFile & { ref: string })[]) =>
  db.chatFile.createMany({ data: files.map((f) => ({ chatId, ...f })), skipDuplicates: true });

/** Name new result files (img_4, …) and record them in one transaction. */
export const nameChatFiles = (chatId: string, files: NewChatFile[]) =>
  prisma.$transaction(async (tx) => {
    const refs = await reserveFileRefs(tx, chatId, files.map((f) => f.kind));
    await addChatFiles(tx, chatId, files.map((f, i) => ({ ...f, ref: refs[i]! })));
    return refs;
  });

const SENT = ["success", "failed", "cancelled"] as const;

/**
 * What the model sees of a chat: the latest summary, the newest `limit` messages after it (oldest first),
 * and every named file in the chat.
 */
export async function loadChatContext(chatId: string, limit: number) {
  const summary = await latestSummary(chatId);
  const after = summary && {
    OR: [{ createdAt: { gt: summary.upToCreatedAt } }, { createdAt: summary.upToCreatedAt, id: { gt: summary.upToMessageId } }],
  };
  const [rows, files] = await Promise.all([
    prisma.message.findMany({
      where: { chatId, status: { in: [...SENT] }, ...after },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: { id: true, role: true, content: true, createdAt: true },
    }),
    prisma.chatFile.findMany({ where: { chatId }, orderBy: { createdAt: "asc" } }),
  ]);
  return {
    summary: summary?.content ?? null,
    messages: rows.reverse().map((r) => ({ id: r.id, createdAt: r.createdAt, role: r.role, content: readContent(r.content) as ContentBlock[] })),
    files: files.map((f) => ({ ref: f.ref, kind: f.kind as FileKind, url: f.url, name: f.name, tool: f.tool, durationSec: f.durationSec })),
  };
}

export const latestSummary = (chatId: string) =>
  prisma.chatSummary.findFirst({ where: { chatId }, orderBy: { upToCreatedAt: "desc" } });

/** Save a summary; the same cut point twice keeps the first (a retried job changes nothing). */
export const saveSummary = (s: { chatId: string; content: string; upToMessageId: string; upToCreatedAt: Date; tokens: number; model: string }) =>
  prisma.chatSummary.upsert({ where: { chatId_upToMessageId: { chatId: s.chatId, upToMessageId: s.upToMessageId } }, create: s, update: {} });
