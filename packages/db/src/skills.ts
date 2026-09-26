import { isUniqueViolation, prisma } from "./client";

export type RecordedSkill = { contentHash: string; content: string; first: boolean };

/**
 * Record that a run loaded a skill. The first load wins: later loads in the same run, including a retry
 * after the file changed on disk, get the stored snapshot back.
 */
export async function recordRunSkill(runId: string, name: string, contentHash: string, content: string): Promise<RecordedSkill> {
  try {
    await prisma.runSkill.create({ data: { runId, name, contentHash, content } });
    return { contentHash, content, first: true };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const row = await prisma.runSkill.findUniqueOrThrow({ where: { runId_name: { runId, name } } });
    return { contentHash: row.contentHash, content: row.content, first: false };
  }
}
