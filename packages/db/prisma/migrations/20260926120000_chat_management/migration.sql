-- DropIndex
DROP INDEX "AgentRun_userMessageId_key";

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "retryOfRunId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_retryOfRunId_key" ON "AgentRun"("retryOfRunId");

-- CreateIndex
CREATE INDEX "AgentRun_userMessageId_idx" ON "AgentRun"("userMessageId");

-- CreateIndex
CREATE INDEX "Chat_userId_pinned_updatedAt_id_idx" ON "Chat"("userId", "pinned", "updatedAt" DESC, "id" DESC);

-- Hand-written: Prisma cannot express a trigram index. Speeds up chat title search (ILIKE '%text%').
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Chat_title_trgm_idx" ON "Chat" USING GIN ("title" gin_trgm_ops) WHERE "deletedAt" IS NULL;
