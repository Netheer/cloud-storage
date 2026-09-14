-- DropIndex
DROP INDEX "StoredObject_sha256_size_key";

-- CreateIndex
CREATE INDEX "StoredObject_sha256_size_idx" ON "StoredObject"("sha256", "size");
