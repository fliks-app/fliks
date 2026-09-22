import { MigrationInterface, QueryRunner } from 'typeorm';

/** A failed adult-group restriction pass said nothing after a successful sync;
 *  the sources health screen now has somewhere to show it. */
export class AddLivetvAdultGuardError1785700000000 implements MigrationInterface {
  name = 'AddLivetvAdultGuardError1785700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "livetv_sources" ADD COLUMN IF NOT EXISTS "lastAdultGuardError" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "livetv_sources" DROP COLUMN IF EXISTS "lastAdultGuardError"`,
    );
  }
}
