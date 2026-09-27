-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "lastPromptTokens" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ChatFile" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT,
    "tool" TEXT,
    "durationSec" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSummary" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "upToMessageId" TEXT NOT NULL,
    "upToCreatedAt" TIMESTAMP(3) NOT NULL,
    "tokens" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatFile_chatId_ref_key" ON "ChatFile"("chatId", "ref");

-- CreateIndex
CREATE INDEX "ChatSummary_chatId_upToCreatedAt_idx" ON "ChatSummary"("chatId", "upToCreatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ChatSummary_chatId_upToMessageId_key" ON "ChatSummary"("chatId", "upToMessageId");

-- AddForeignKey
ALTER TABLE "ChatFile" ADD CONSTRAINT "ChatFile_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSummary" ADD CONSTRAINT "ChatSummary_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every named file already in a chat (uploads and tool results), so old chats keep working after trimming.
INSERT INTO "ChatFile" ("id", "chatId", "ref", "kind", "url", "name", "tool", "durationSec", "createdAt")
SELECT gen_random_uuid()::text, m."chatId", b->>'ref', b->>'kind', b->>'url',
  CASE WHEN b->>'type' = 'attachment' THEN b->>'name' END,
  (SELECT u->>'name' FROM jsonb_array_elements(m."content") u
    WHERE u->>'type' = 'tool_use' AND u->>'toolCallId' = b->>'toolCallId' LIMIT 1),
  (b->>'durationSec')::double precision, m."createdAt"
FROM "Message" m CROSS JOIN LATERAL jsonb_array_elements(m."content") b
WHERE jsonb_typeof(m."content") = 'array' AND b->>'type' IN ('attachment', 'asset') AND b->>'ref' IS NOT NULL
ON CONFLICT ("chatId", "ref") DO NOTHING;
