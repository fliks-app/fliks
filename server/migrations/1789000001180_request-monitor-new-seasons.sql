-- The requester's "follow new seasons" choice, kept on a pending series request until its approval.
ALTER TABLE "requests" ADD COLUMN "monitorNewSeasons" boolean,
  ADD CONSTRAINT "CK_requests_monitorNewSeasons" CHECK ("monitorNewSeasons" IS NULL OR "mediaType" = 'series');
