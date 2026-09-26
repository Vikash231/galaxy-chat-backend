-- CreateEnum
CREATE TYPE "WaitpointKind" AS ENUM ('options', 'plan', 'credit', 'media');

-- CreateEnum
CREATE TYPE "WaitpointStatus" AS ENUM ('pending', 'answered', 'expired', 'cancelled');

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "planMode" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Waitpoint" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "WaitpointKind" NOT NULL,
    "request" JSONB NOT NULL,
    "status" "WaitpointStatus" NOT NULL DEFAULT 'pending',
    "answer" JSONB,
    "tokenId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Waitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_tokenId_key" ON "Waitpoint"("tokenId");

-- CreateIndex
CREATE INDEX "Waitpoint_runId_status_idx" ON "Waitpoint"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_runId_key_key" ON "Waitpoint"("runId", "key");

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
