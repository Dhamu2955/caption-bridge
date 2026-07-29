-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "ServiceSource" AS ENUM ('rip', 'live');

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "speaker" TEXT NOT NULL,
    "title" TEXT,
    "source" "ServiceSource" NOT NULL DEFAULT 'rip',
    "videoPath" TEXT NOT NULL,
    "durationMs" INTEGER,
    "trimStartMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Segment" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "original" TEXT NOT NULL,
    "translation" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "speaker" TEXT,
    "editedBy" TEXT NOT NULL DEFAULT 'soniox',
    "editedAt" TIMESTAMP(3),
    "previousTranslation" TEXT,

    CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Service_videoPath_key" ON "Service"("videoPath");

-- CreateIndex
CREATE INDEX "Service_date_idx" ON "Service"("date");

-- CreateIndex
CREATE INDEX "Segment_serviceId_startMs_idx" ON "Segment"("serviceId", "startMs");

-- CreateIndex
CREATE UNIQUE INDEX "Segment_serviceId_index_key" ON "Segment"("serviceId", "index");

-- AddForeignKey
ALTER TABLE "Segment" ADD CONSTRAINT "Segment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
