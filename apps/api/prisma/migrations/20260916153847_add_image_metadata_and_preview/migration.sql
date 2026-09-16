/*
  Warnings:

  - A unique constraint covering the columns `[previewObjectKey]` on the table `FileVersion` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "FileVersion" ADD COLUMN     "imageFormat" TEXT,
ADD COLUMN     "imageHeight" INTEGER,
ADD COLUMN     "imageWidth" INTEGER,
ADD COLUMN     "previewHeight" INTEGER,
ADD COLUMN     "previewMimeType" TEXT,
ADD COLUMN     "previewObjectKey" TEXT,
ADD COLUMN     "previewWidth" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "FileVersion_previewObjectKey_key" ON "FileVersion"("previewObjectKey");
