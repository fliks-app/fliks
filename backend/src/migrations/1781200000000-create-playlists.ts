import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePlaylists1781200000000 implements MigrationInterface {
  name = 'CreatePlaylists1781200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."playlist_shares_role_enum"
        AS ENUM('viewer', 'editor', 'administrator')
    `);

    await queryRunner.query(`
      CREATE TABLE "playlists" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "name" varchar(255) NOT NULL,
        "ownerId" int NOT NULL,
        "autoRemoveWatched" boolean NOT NULL DEFAULT false,
        "autoDownload" boolean NOT NULL DEFAULT false,
        "coverImageUrl" varchar(512),
        CONSTRAINT "FK_playlists_owner"
          FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_playlists_ownerId" ON "playlists" ("ownerId")
    `);

    await queryRunner.query(`
      CREATE TABLE "playlist_items" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "playlistId" int NOT NULL,
        "mediaId" int NOT NULL,
        "episodeId" int,
        "position" int NOT NULL,
        "addedById" int,
        CONSTRAINT "FK_playlist_items_playlist"
          FOREIGN KEY ("playlistId") REFERENCES "playlists"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_playlist_items_media"
          FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_playlist_items_episode"
          FOREIGN KEY ("episodeId") REFERENCES "episodes"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_playlist_items_addedBy"
          FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_playlist_items_playlist_position"
        ON "playlist_items" ("playlistId", "position")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_playlist_items_mediaId"
        ON "playlist_items" ("mediaId")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_playlist_items_episodeId"
        ON "playlist_items" ("episodeId")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_playlist_items_addedById"
        ON "playlist_items" ("addedById")
    `);
    // A movie appears at most once per playlist; an episode at most once per
    // playlist. Two partial indexes because a plain UNIQUE(playlistId, mediaId,
    // episodeId) would let duplicate movies through (Postgres treats NULLs as
    // distinct by default).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_playlist_items_movie"
        ON "playlist_items" ("playlistId", "mediaId")
        WHERE "episodeId" IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_playlist_items_episode"
        ON "playlist_items" ("playlistId", "episodeId")
        WHERE "episodeId" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "playlist_shares" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "playlistId" int NOT NULL,
        "userId" int NOT NULL,
        "role" "public"."playlist_shares_role_enum" NOT NULL DEFAULT 'viewer',
        CONSTRAINT "FK_playlist_shares_playlist"
          FOREIGN KEY ("playlistId") REFERENCES "playlists"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_playlist_shares_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_playlist_shares_playlist_user"
          UNIQUE ("playlistId", "userId")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_playlist_shares_playlistId"
        ON "playlist_shares" ("playlistId")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_playlist_shares_userId"
        ON "playlist_shares" ("userId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "playlist_shares"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "playlist_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "playlists"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."playlist_shares_role_enum"`,
    );
  }
}
