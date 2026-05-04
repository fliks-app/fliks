import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropProviderKeySettings1777886651743 implements MigrationInterface {
  name = 'DropProviderKeySettings1777886651743';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "app_settings" WHERE "key" IN ('tmdb_api_key', 'tvdb_api_key', 'tvdb_pin')`,
    );
  }

  public async down(): Promise<void> {
    // No rollback: keys are no longer read from DB; restoring them
    // would have no effect anyway. Forward-fix only.
  }
}
