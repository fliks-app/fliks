import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSocialFeature1781400000000 implements MigrationInterface {
  name = 'AddSocialFeature1781400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enum types (guarded so re-runs / dev synchronize don't clash).
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."users_profilevisibility_enum" AS ENUM('public', 'private');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."playlists_visibility_enum" AS ENUM('private', 'followers', 'public');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."user_follows_status_enum" AS ENUM('pending', 'accepted');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    // User privacy columns.
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profileVisibility" "public"."users_profilevisibility_enum" NOT NULL DEFAULT 'private'`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareTastes" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareRecommendations" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareWatchHistory" boolean NOT NULL DEFAULT false`,
    );

    // Playlist visibility.
    await queryRunner.query(
      `ALTER TABLE "playlists" ADD COLUMN IF NOT EXISTS "visibility" "public"."playlists_visibility_enum" NOT NULL DEFAULT 'private'`,
    );

    // Follow graph.
    await queryRunner.query(`
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
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_follows_follower" ON "user_follows" ("followerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_follows_following" ON "user_follows" ("followingId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_follows"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."user_follows_status_enum"`);
    await queryRunner.query(`ALTER TABLE "playlists" DROP COLUMN IF EXISTS "visibility"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."playlists_visibility_enum"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "shareWatchHistory"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "shareRecommendations"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "shareTastes"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "profileVisibility"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_profilevisibility_enum"`);
  }
}
