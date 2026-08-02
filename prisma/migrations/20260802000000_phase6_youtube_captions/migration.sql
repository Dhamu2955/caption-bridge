-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "youtubeVideoId" TEXT;

-- CreateTable
CREATE TABLE "CaptionUpload" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaptionUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CaptionUpload_serviceId_language_key" ON "CaptionUpload"("serviceId", "language");

-- AddForeignKey
ALTER TABLE "CaptionUpload" ADD CONSTRAINT "CaptionUpload_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
