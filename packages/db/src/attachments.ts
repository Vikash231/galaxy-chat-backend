import { AppError, type AttachmentView, type ContentBlock } from "@gx/contracts";
import { prisma, type Tx } from "./client";

export type NewAttachment = Omit<AttachmentView, "id" | "sizeBytes"> & {
  userId: string;
  assemblyId: string;
  transloaditFileId: string;
  sizeBytes: number;
};

type Row = Awaited<ReturnType<typeof prisma.attachment.findFirstOrThrow>>;

export const toAttachmentView = (a: Row): AttachmentView => ({
  id: a.id,
  kind: a.kind as AttachmentView["kind"],
  name: a.name,
  mime: a.mime,
  sizeBytes: Number(a.sizeBytes),
  width: a.width,
  height: a.height,
  durationSec: a.durationSec,
  url: a.url,
  persistent: a.persistent,
});

/** Record the files of a completed Assembly; completing the same Assembly twice returns the same rows. */
export async function saveAttachments(files: NewAttachment[]) {
  const rows = await prisma.$transaction(
    files.map((f) =>
      prisma.attachment.upsert({
        where: { assemblyId_transloaditFileId: { assemblyId: f.assemblyId, transloaditFileId: f.transloaditFileId } },
        create: { ...f, sizeBytes: BigInt(f.sizeBytes) },
        update: {},
      }),
    ),
  );
  return rows.map(toAttachmentView);
}

/** Bytes uploaded this calendar month across the account (the Community plan quota is account-wide). */
export async function monthlyUploadBytes(): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const r = await prisma.attachment.aggregate({ _sum: { sizeBytes: true }, where: { createdAt: { gte: start } } });
  return Number(r._sum.sizeBytes ?? 0n);
}

/**
 * Link attachments to a message inside the send transaction.
 * Every id must belong to the user and not already be used by another message; order is preserved.
 */
export async function claimAttachments(tx: Tx, userId: string, chatId: string, messageId: string, ids: string[]): Promise<ContentBlock[]> {
  if (!ids.length) return [];
  const { count } = await tx.attachment.updateMany({ where: { id: { in: ids }, userId, messageId: null }, data: { messageId } });
  if (count !== new Set(ids).size) throw new AppError("upload_rejected", "One of the attached files is missing or already used. Attach it again.");
  const rows = await tx.attachment.findMany({ where: { id: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const refs = await reserveFileRefs(tx, chatId, ids.map((id) => byId.get(id)!.kind as FileKind));
  return ids.map((id, i) => {
    const a = byId.get(id)!;
    return { type: "attachment", attachmentId: a.id, ref: refs[i], kind: a.kind as FileKind, url: a.url, name: a.name, mime: a.mime, width: a.width, height: a.height, durationSec: a.durationSec };
  });
}

type FileKind = "image" | "video" | "audio";
const PREFIX: Record<FileKind, string> = { image: "img", video: "vid", audio: "aud" };

/**
 * Hand out chat-unique file names (img_1, vid_2, …) from the chat's counter.
 * The counter is a single atomic increment, so concurrent uploads and tool results never get the same name.
 */
export async function reserveFileRefs(db: Tx, chatId: string, kinds: FileKind[]): Promise<string[]> {
  if (!kinds.length) return [];
  const { imageSeq } = await db.chat.update({ where: { id: chatId }, data: { imageSeq: { increment: kinds.length } }, select: { imageSeq: true } });
  const first = imageSeq - kinds.length + 1;
  return kinds.map((k, i) => `${PREFIX[k]}_${first + i}`);
}
