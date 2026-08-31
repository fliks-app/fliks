import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRemoteControlGrants1784500000000 implements MigrationInterface {
  name = 'AddRemoteControlGrants1784500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "remote_control_grants" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "code" character varying(12),
        "deviceId" character varying NOT NULL,
        "ownerUserId" integer NOT NULL,
        "granteeUserId" integer,
        "deviceName" character varying NOT NULL,
        "codeExpiresAt" timestamptz NOT NULL
      )
    `);
    for (const column of ['code', 'deviceId', 'ownerUserId', 'granteeUserId']) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_remote_control_grants_${column}" ON "remote_control_grants" ("${column}")`,
      );
    }
    // A per-device grant replaces the mutual-follow gating, so the two account
    // flags that only ever gated that path have nothing left to gate.
    for (const column of [
      'allowRemoteControlOfOthers',
      'allowRemoteControlOfMyDevices',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "users" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of [
      'allowRemoteControlOfOthers',
      'allowRemoteControlOfMyDevices',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "${column}" boolean NOT NULL DEFAULT false`,
      );
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "remote_control_grants"`);
  }
}
