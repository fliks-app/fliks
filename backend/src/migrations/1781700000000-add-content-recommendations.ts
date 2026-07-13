import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddContentRecommendations1781700000000
  implements MigrationInterface
{
  name = 'AddContentRecommendations1781700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "content_recommendations" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "senderId" int NOT NULL,
        "recipientId" int NOT NULL,
        "mediaId" int NOT NULL,
        "seasonId" int,
        "episodeId" int,
        "message" text,
        "dismissedAt" timestamptz,
        CONSTRAINT "FK_content_recommendations_sender" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_content_recommendations_recipient" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_content_recommendations_media" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_content_recommendations_season" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_content_recommendations_episode" FOREIGN KEY ("episodeId") REFERENCES "episodes"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_content_recommendations_recipient" ON "content_recommendations" ("recipientId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "content_recommendations"`,
    );
  }
}
