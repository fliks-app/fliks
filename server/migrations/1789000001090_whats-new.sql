ALTER TABLE users ADD COLUMN "whatsNewEnabled" boolean NOT NULL DEFAULT true;
-- NULL (an account created later) records the running version without showing notes.
ALTER TABLE users ADD COLUMN "whatsNewSeen" text;
-- Existing accounts see the notes shipped after 5.0.0.
ALTER TABLE users DISABLE TRIGGER set_updated_at;
UPDATE users SET "whatsNewSeen" = '5.0.0';
ALTER TABLE users ENABLE TRIGGER set_updated_at;
