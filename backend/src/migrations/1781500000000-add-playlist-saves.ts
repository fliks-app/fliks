import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPlaylistSaves1781500000000 implements MigrationInterface {
  name = 'AddPlaylistSaves1781500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "playlist_saves" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "userId" int NOT NULL,
        "playlistId" int NOT NULL,
        CONSTRAINT "UQ_playlist_saves_pair" UNIQUE ("userId", "playlistId"),
        CONSTRAINT "FK_playlist_saves_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_playlist_saves_playlist"
          FOREIGN KEY ("playlistId") REFERENCES "playlists"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_playlist_saves_user" ON "playlist_saves" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "playlist_saves"`);
  }
}
