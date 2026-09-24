-- CreateEnum
CREATE TYPE "AccessRole" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- CreateTable
CREATE TABLE "FolderAccessGrant" (
    "id" UUID NOT NULL,
    "folderId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "AccessRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FolderAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAccessGrant" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "AccessRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FolderAccessGrant_userId_idx" ON "FolderAccessGrant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FolderAccessGrant_folderId_userId_key" ON "FolderAccessGrant"("folderId", "userId");

-- CreateIndex
CREATE INDEX "FileAccessGrant_userId_idx" ON "FileAccessGrant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FileAccessGrant_fileId_userId_key" ON "FileAccessGrant"("fileId", "userId");

-- AddForeignKey
ALTER TABLE "FolderAccessGrant" ADD CONSTRAINT "FolderAccessGrant_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FolderAccessGrant" ADD CONSTRAINT "FolderAccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAccessGrant" ADD CONSTRAINT "FileAccessGrant_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAccessGrant" ADD CONSTRAINT "FileAccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
