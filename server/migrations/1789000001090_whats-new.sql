ALTER TABLE users ADD COLUMN "whatsNewEnabled" boolean NOT NULL DEFAULT true;
-- NULL until a client records the version it runs: an account without a value sees no notes.
ALTER TABLE users ADD COLUMN "whatsNewSeen" text;
