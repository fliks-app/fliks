import { MigrationInterface, QueryRunner } from 'typeorm';

/** Managing roles is its own permission now. Whoever could do it through `users.manage`
 *  keeps it, so an upgrade never silently locks an operator out of the roles editor. */
export class SplitRolesManagePermission1785200000000 implements MigrationInterface {
  name = 'SplitRolesManagePermission1785200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "roles"
       SET "permissions" = ("permissions"::jsonb || '["roles.manage"]'::jsonb)::text
       WHERE "permissions"::jsonb ? 'users.manage'
         AND NOT ("permissions"::jsonb ? 'roles.manage')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "roles"
       SET "permissions" = COALESCE(
             (SELECT jsonb_agg(p) FROM jsonb_array_elements("permissions"::jsonb) AS t(p) WHERE p <> '"roles.manage"'::jsonb),
             '[]'::jsonb
           )::text
       WHERE "permissions"::jsonb ? 'roles.manage'`,
    );
  }
}
