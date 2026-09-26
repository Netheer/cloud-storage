-- CreateEnum
CREATE TYPE "ProcessingFailureKind" AS ENUM ('RECOVERABLE_EXHAUSTED', 'UNRECOVERABLE');

-- CreateTable
CREATE TABLE "ProcessingFailure" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "jobId" TEXT,
    "kind" "ProcessingFailureKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessingFailure_fileId_failedAt_idx" ON "ProcessingFailure"("fileId", "failedAt");

-- CreateIndex
CREATE INDEX "ProcessingFailure_versionId_failedAt_idx" ON "ProcessingFailure"("versionId", "failedAt");

-- AddForeignKey
ALTER TABLE "ProcessingFailure" ADD CONSTRAINT "ProcessingFailure_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingFailure" ADD CONSTRAINT "ProcessingFailure_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "FileVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
