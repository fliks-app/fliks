ALTER TABLE "persons" ADD COLUMN IF NOT EXISTS "provider" character varying(16) NOT NULL DEFAULT 'tmdb';

ALTER TABLE "persons" DROP CONSTRAINT IF EXISTS "UQ_4069db2315833af2a2bcdc59c42";

ALTER TABLE "persons" ADD CONSTRAINT "UQ_677a19ecc46b5da7b1a4314c82b" UNIQUE ("provider", "tmdbId");
