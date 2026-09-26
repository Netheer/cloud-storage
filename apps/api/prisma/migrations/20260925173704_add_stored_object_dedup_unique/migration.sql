/*
  Warnings:

  - A unique constraint covering the columns `[sha256,size]` on the table `StoredObject` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "StoredObject_sha256_size_key" ON "StoredObject"("sha256", "size");
