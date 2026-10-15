
      DO $$ BEGIN
        CREATE TYPE "public"."users_profilevisibility_enum" AS ENUM('public', 'private');
      EXCEPTION WHEN duplicate_object THEN null; END $$;


      DO $$ BEGIN
        CREATE TYPE "public"."playlists_visibility_enum" AS ENUM('private', 'followers', 'public');
      EXCEPTION WHEN duplicate_object THEN null; END $$;


      DO $$ BEGIN
        CREATE TYPE "public"."user_follows_status_enum" AS ENUM('pending', 'accepted');
      EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profileVisibility" "public"."users_profilevisibility_enum" NOT NULL DEFAULT 'private';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareTastes" boolean NOT NULL DEFAULT false;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareRecommendations" boolean NOT NULL DEFAULT false;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareWatchHistory" boolean NOT NULL DEFAULT false;

ALTER TABLE "playlists" ADD COLUMN IF NOT EXISTS "visibility" "public"."playlists_visibility_enum" NOT NULL DEFAULT 'private';


      CREATE TABLE IF NOT EXISTS "user_follows" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "followerId" int NOT NULL,
        "followingId" int NOT NULL,
        "status" "public"."user_follows_status_enum" NOT NULL DEFAULT 'accepted',
        CONSTRAINT "UQ_user_follows_pair" UNIQUE ("followerId", "followingId"),
        CONSTRAINT "FK_user_follows_follower"
          FOREIGN KEY ("followerId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_follows_following"
          FOREIGN KEY ("followingId") REFERENCES "users"("id") ON DELETE CASCADE
      );

CREATE INDEX IF NOT EXISTS "IDX_user_follows_follower" ON "user_follows" ("followerId");

CREATE INDEX IF NOT EXISTS "IDX_user_follows_following" ON "user_follows" ("followingId");
