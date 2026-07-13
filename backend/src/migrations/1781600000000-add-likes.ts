import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLikes1781600000000 implements MigrationInterface {
  name = 'AddLikes1781600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "likes" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "userId" int NOT NULL,
        "mediaId" int NOT NULL,
        "seasonId" int,
        "episodeId" int,
        CONSTRAINT "FK_likes_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_likes_media" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_likes_season" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_likes_episode" FOREIGN KEY ("episodeId") REFERENCES "episodes"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_likes_user" ON "likes" ("userId")`,
    );
    // One like per granularity (partial unique indexes — the NULL split).
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_likes_movie" ON "likes" ("userId", "mediaId") WHERE "seasonId" IS NULL AND "episodeId" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_likes_season" ON "likes" ("userId", "seasonId") WHERE "seasonId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_likes_episode" ON "likes" ("userId", "episodeId") WHERE "episodeId" IS NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareLikes" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "shareLikes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "likes"`);
  }
}
