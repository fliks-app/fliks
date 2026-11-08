-- Token and salt authentication needs the cleartext password: a `subsonic` row keeps it encrypted
ALTER TABLE "device_tokens" ADD COLUMN "secret" bytea,
  ADD CONSTRAINT "CK_device_tokens_secret" CHECK ("secret" IS NULL OR "kind" = 'subsonic');
