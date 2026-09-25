-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant', 'system', 'tool');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('streaming', 'success', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ToolStatus" AS ENUM ('pending', 'dispatching', 'running', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "balanceMicro" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'success',
    "content" JSONB NOT NULL,
    "clientMessageId" TEXT,
    "runId" TEXT,
    "checkpointStep" INTEGER NOT NULL DEFAULT -1,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorRetryable" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userMessageId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "triggerRunId" TEXT,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "routedModels" TEXT[],
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorRetryable" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolInvocation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ToolStatus" NOT NULL DEFAULT 'pending',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "magicaRunId" TEXT,
    "estimateMicro" BIGINT NOT NULL DEFAULT 0,
    "creditsMicro" BIGINT NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorRetryable" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deltaMicro" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "runId" TEXT,
    "toolInvocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderSpendDaily" (
    "provider" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "spentMicro" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ProviderSpendDaily_pkey" PRIMARY KEY ("provider","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkId_key" ON "User"("clerkId");

-- CreateIndex
CREATE INDEX "Chat_userId_updatedAt_id_idx" ON "Chat"("userId", "updatedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Message_runId_key" ON "Message"("runId");

-- CreateIndex
CREATE INDEX "Message_chatId_createdAt_id_idx" ON "Message"("chatId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Message_chatId_clientMessageId_key" ON "Message"("chatId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_userMessageId_key" ON "AgentRun"("userMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_triggerRunId_key" ON "AgentRun"("triggerRunId");

-- CreateIndex
CREATE INDEX "AgentRun_chatId_createdAt_idx" ON "AgentRun"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_userId_createdAt_idx" ON "AgentRun"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_magicaRunId_key" ON "ToolInvocation"("magicaRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_runId_toolCallId_key" ON "ToolInvocation"("runId", "toolCallId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_idempotencyKey_key" ON "CreditLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedger_runId_idx" ON "CreditLedger"("runId");

-- CreateIndex
CREATE INDEX "CreditLedger_toolInvocationId_idx" ON "CreditLedger"("toolInvocationId");

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: Prisma cannot express partial indexes.
-- One active run per chat, enforced by the database.
CREATE UNIQUE INDEX "AgentRun_one_active_per_chat" ON "AgentRun"("chatId") WHERE "status" IN ('queued', 'running', 'waiting');
