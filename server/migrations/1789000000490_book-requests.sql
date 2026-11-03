ALTER TABLE "requests" ADD COLUMN "wants" jsonb,
  ADD CONSTRAINT "CK_requests_wants" CHECK (("mediaType" = 'book' AND kind = 'add') = ("wants" IS NOT NULL));
