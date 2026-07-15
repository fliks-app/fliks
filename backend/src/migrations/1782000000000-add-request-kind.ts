import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `kind` discriminator to requests so the request system carries both
 * add and delete requests on one entity. Existing rows are add requests, hence
 * NOT NULL DEFAULT 'add'.
 */
export class AddRequestKind1782000000000 implements MigrationInterface {
  name = 'AddRequestKind1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."requests_kind_enum" AS ENUM('add', 'delete');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(
      `ALTER TABLE "requests" ADD COLUMN IF NOT EXISTS "kind" "public"."requests_kind_enum" NOT NULL DEFAULT 'add'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "requests" DROP COLUMN IF EXISTS "kind"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."requests_kind_enum"`);
  }
}
