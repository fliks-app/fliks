ALTER TYPE "public"."subtitle_files_providertype_enum" ADD VALUE IF NOT EXISTS 'ocr';

ALTER TYPE "public"."subtitle_providers_type_enum" ADD VALUE IF NOT EXISTS 'ocr';

ALTER TYPE "public"."subtitle_files_status_enum" ADD VALUE IF NOT EXISTS 'processing';
