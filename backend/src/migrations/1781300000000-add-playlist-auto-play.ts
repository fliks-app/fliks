import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPlaylistAutoPlay1781300000000 implements MigrationInterface {
  name = 'AddPlaylistAutoPlay1781300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "playlists" ADD COLUMN IF NOT EXISTS "autoPlay" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "playlists" DROP COLUMN IF EXISTS "autoPlay"`,
    );
  }
}
