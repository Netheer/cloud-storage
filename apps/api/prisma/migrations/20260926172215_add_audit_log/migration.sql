-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('FILE_UPLOAD', 'FILE_DELETE', 'FILE_RENAME', 'FILE_MOVE', 'FILE_VERSION_UPLOAD', 'FILE_VERSION_RESTORE', 'FILE_PROCESSING_RETRY', 'FOLDER_CREATE', 'FOLDER_DELETE', 'FOLDER_RENAME', 'FOLDER_MOVE', 'SHARE_CREATE', 'SHARE_UPDATE', 'SHARE_REVOKE', 'PUBLIC_LINK_CREATE', 'PUBLIC_LINK_REVOKE');

-- CreateEnum
CREATE TYPE "AuditResourceType" AS ENUM ('FILE', 'FOLDER', 'SHARE', 'PUBLIC_LINK');

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "action" "AuditAction" NOT NULL,
    "resourceType" "AuditResourceType" NOT NULL,
    "resourceId" UUID NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_createdAt_idx" ON "AuditLog"("resourceType", "resourceId", "createdAt");
