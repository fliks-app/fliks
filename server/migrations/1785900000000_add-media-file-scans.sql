CREATE TABLE "media_file_scans" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "mediaFileId" integer NOT NULL, "size" bigint NOT NULL, "mtimeMs" double precision NOT NULL, "scan" jsonb NOT NULL, CONSTRAINT "PK_b43c049e9581265f39b2eabc472" PRIMARY KEY ("id"));

CREATE UNIQUE INDEX "UQ_media_file_scans_media_file" ON "media_file_scans" ("mediaFileId");

ALTER TABLE "media_file_scans" ADD CONSTRAINT "FK_af6e69aca953537e68d29c82d0c" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
