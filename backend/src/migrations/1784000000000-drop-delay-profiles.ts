import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `delay_profiles` held a `torrentDelay` nothing ever read: the rule that would have applied it
 * was unreachable, so the settings page accepted a value, stored it, and changed no behaviour.
 *
 * Not restored instead of dropped because the feature's main purpose does not exist here — its
 * usual job is to arbitrate between Usenet and torrent, and this system only speaks torrent — and
 * because the quality profile's own allowed set, size limits and upgrade cutoff already cover the
 * remaining case of "wait for something better".
 *
 * `down` recreates the table empty. The rows carried no behaviour, so there is nothing to restore
 * into it, and no installation had one unless an admin created it by hand.
 */
export class DropDelayProfiles1784000000000 implements MigrationInterface {
  name = 'DropDelayProfiles1784000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "delay_profiles"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "delay_profiles" (
        "id" SERIAL NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "torrentDelay" integer NOT NULL DEFAULT '0',
        "order" integer NOT NULL DEFAULT '1',
        CONSTRAINT "PK_0fdbcfaa90c5e6ee74b4639e3d4" PRIMARY KEY ("id")
      )`,
    );
  }
}
