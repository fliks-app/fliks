ALTER TABLE "media"
  ALTER COLUMN "type" TYPE text USING "type"::text,
  ADD CONSTRAINT "CK_media_type" CHECK ("type" IN ('movie', 'series'));
ALTER TABLE "requests"
  ALTER COLUMN "mediaType" TYPE text USING "mediaType"::text,
  ADD CONSTRAINT "CK_requests_mediaType" CHECK ("mediaType" IN ('movie', 'series'));
DROP TYPE "public"."media_type_enum";
DROP TYPE "public"."requests_mediatype_enum";
