-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "firstSegmentIndex" INTEGER NOT NULL,
    "lastSegmentIndex" INTEGER NOT NULL,
    "original" TEXT NOT NULL,
    "translation" TEXT NOT NULL,

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChunkEmbedding" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "embedding" vector(384) NOT NULL,

    CONSTRAINT "ChunkEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chunk_serviceId_startMs_idx" ON "Chunk"("serviceId", "startMs");

-- CreateIndex
CREATE UNIQUE INDEX "Chunk_serviceId_index_key" ON "Chunk"("serviceId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "ChunkEmbedding_chunkId_language_model_key" ON "ChunkEmbedding"("chunkId", "language", "model");

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChunkEmbedding" ADD CONSTRAINT "ChunkEmbedding_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "Chunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
