import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the native host OS name+version ("macOS 26", "iOS 18.5") captured by the
 * requesting device to pairing requests, so the approval UI can show a real
 * device label instead of a frozen-UA browser+OS guess.
 */
export class AddPairingSystemName1781000000000 implements MigrationInterface {
  name = 'AddPairingSystemName1781000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pairing_requests" ADD COLUMN IF NOT EXISTS "systemName" varchar(60)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pairing_requests" DROP COLUMN IF EXISTS "systemName"`,
    );
  }
}
