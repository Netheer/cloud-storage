-- CreateTable
CREATE TABLE "FolderPublicLink" (
    "id" UUID NOT NULL,
    "folderId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FolderPublicLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilePublicLink" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FilePublicLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FolderPublicLink_tokenHash_key" ON "FolderPublicLink"("tokenHash");

-- CreateIndex
CREATE INDEX "FolderPublicLink_folderId_idx" ON "FolderPublicLink"("folderId");

-- CreateIndex
CREATE INDEX "FolderPublicLink_expiresAt_idx" ON "FolderPublicLink"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "FilePublicLink_tokenHash_key" ON "FilePublicLink"("tokenHash");

-- CreateIndex
CREATE INDEX "FilePublicLink_fileId_idx" ON "FilePublicLink"("fileId");

-- CreateIndex
CREATE INDEX "FilePublicLink_expiresAt_idx" ON "FilePublicLink"("expiresAt");

-- AddForeignKey
ALTER TABLE "FolderPublicLink" ADD CONSTRAINT "FolderPublicLink_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilePublicLink" ADD CONSTRAINT "FilePublicLink_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
