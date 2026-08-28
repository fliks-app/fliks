import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `auto_approval_rules.conditions` held a generic field/operator/value triplet list, and its DTO
 * never validated `value` — under the global `forbidNonWhitelisted` pipe every create and update
 * was rejected, so no installation can hold a rule. Nothing to convert: the column is replaced by
 * a typed `criteria` object.
 *
 * `priority` goes with it. Rules are OR'd (one match approves), so the ordering it defined never
 * changed an outcome.
 *
 * Both `ADD COLUMN`s are `NOT NULL` without a default: the `DELETE` above leaves no row to
 * backfill, and a default the entity does not declare fails the schema-drift check.
 */
export class AutoApprovalCriteria1784200000000 implements MigrationInterface {
  name = 'AutoApprovalCriteria1784200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "auto_approval_rules"`);
    await queryRunner.query(
      `ALTER TABLE "auto_approval_rules" DROP COLUMN "conditions"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auto_approval_rules" DROP COLUMN "priority"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auto_approval_rules" ADD "criteria" jsonb NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "auto_approval_rules"`);
    await queryRunner.query(
      `ALTER TABLE "auto_approval_rules" DROP COLUMN "criteria"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auto_approval_rules" ADD "conditions" jsonb NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "auto_approval_rules" ADD "priority" integer NOT NULL DEFAULT '0'`,
    );
  }
}
