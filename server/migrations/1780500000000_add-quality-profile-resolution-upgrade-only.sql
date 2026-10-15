
      ALTER TABLE "quality_profiles"
        ADD COLUMN IF NOT EXISTS "resolutionUpgradeOnly" boolean NOT NULL DEFAULT false;
