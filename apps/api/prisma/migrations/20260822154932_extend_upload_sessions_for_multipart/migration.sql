/*
  Warnings:

  - A unique constraint covering the columns `[ownerId,clientRequestId]` on the table `UploadSession` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `clientRequestId` to the `UploadSession` table without a default value. This is not possible if the table is not empty.
  - Added the required column `partSize` to the `UploadSession` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalParts` to the `UploadSession` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "UploadSession" ADD COLUMN     "clientRequestId" UUID NOT NULL,
ADD COLUMN     "partSize" BIGINT NOT NULL,
ADD COLUMN     "totalParts" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_ownerId_clientRequestId_key" ON "UploadSession"("ownerId", "clientRequestId");
