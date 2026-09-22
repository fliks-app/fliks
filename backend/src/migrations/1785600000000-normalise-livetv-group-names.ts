import { MigrationInterface, QueryRunner } from 'typeorm';

/** Must match `UNGROUPED_SENTINEL` in `parsing/group-name.ts`. */
const UNGROUPED_SENTINEL = '__livetv_ungrouped__';

/**
 * Existing installs carry group names ingestion never trimmed, channels with
 * no group at all (stored as NULL/''), and case variants of the same
 * provider category restricted one spelling at a time. This backfills the
 * same normalisation the ingestion-side fix now applies going forward, and
 * folds the duplicate rows that trimming surfaces in the tables that key on
 * a group name literally (a user's per-group grant, unique per user+name).
 */
export class NormaliseLivetvGroupNames1785600000000 implements MigrationInterface {
  name = 'NormaliseLivetvGroupNames1785600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Tracks whether a channel's group came from the provider or an admin
    // edit, so a sync can realign the former without ever touching the latter.
    await queryRunner.query(
      `ALTER TABLE "livetv_channels" ADD COLUMN "groupNameSource" character varying(16) NOT NULL DEFAULT 'provider'`,
    );

    await queryRunner.query(
      `UPDATE "livetv_channels"
       SET "groupName" = CASE
         WHEN "groupName" IS NULL OR btrim("groupName") = '' THEN $1
         ELSE btrim("groupName")
       END
       WHERE "groupName" IS NULL OR "groupName" != btrim("groupName") OR btrim("groupName") = ''`,
      [UNGROUPED_SENTINEL],
    );

    // Lets a restriction match fold case/whitespace via the same expression
    // (`lower(btrim("groupName"))`) the queries use, without a generated column.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_livetv_channels_group_norm" ON "livetv_channels" (lower(btrim("groupName")))`,
    );

    // Trimming can make two grant rows for the same user collide with the
    // unique (userId, groupName) index; drop the extra before rewriting it.
    await queryRunner.query(
      `DELETE FROM "livetv_group_access" a
       USING "livetv_group_access" b
       WHERE a.id > b.id
         AND a."userId" = b."userId"
         AND btrim(a."groupName") = btrim(b."groupName")`,
    );
    await queryRunner.query(
      `UPDATE "livetv_group_access" SET "groupName" = btrim("groupName") WHERE "groupName" != btrim("groupName")`,
    );

    await this.normalizeGroupListSetting(
      queryRunner,
      'livetv_restricted_groups',
    );
    await this.normalizeGroupListSetting(
      queryRunner,
      'livetv_restricted_groups_exempt',
    );
    await this.normalizeVanishedGroupsSetting(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_livetv_channels_group_norm"`,
    );
    await queryRunner.query(
      `ALTER TABLE "livetv_channels" DROP COLUMN "groupNameSource"`,
    );
    // The trim/sentinel rewrite and the grant-row merge above are lossy (original
    // whitespace, NULL/'' state and the dropped duplicate rows are gone); left as-is.
  }

  /** `app_settings.value` for a restricted/exempt-groups key: a JSON string array. */
  private async normalizeGroupListSetting(
    queryRunner: QueryRunner,
    key: string,
  ): Promise<void> {
    const rows = await queryRunner.query(
      `SELECT value FROM "app_settings" WHERE key = $1`,
      [key],
    );
    const raw: string | null = rows[0]?.value ?? null;
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    const normalized = [
      ...new Set(
        parsed
          .filter((g): g is string => typeof g === 'string')
          .map((g) => g.trim())
          .filter(Boolean),
      ),
    ].sort();
    await queryRunner.query(
      `UPDATE "app_settings" SET value = $1 WHERE key = $2`,
      [JSON.stringify(normalized), key],
    );
  }

  /** `app_settings.value` for `livetv_restricted_groups_vanished`: a JSON object
   *  of group name to the ISO date it went missing. Trimming can collide two
   *  keys; the earliest date wins, since that is the more conservative one for
   *  the grace-period countdown. */
  private async normalizeVanishedGroupsSetting(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const rows = await queryRunner.query(
      `SELECT value FROM "app_settings" WHERE key = 'livetv_restricted_groups_vanished'`,
    );
    const raw: string | null = rows[0]?.value ?? null;
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const merged: Record<string, string> = {};
    for (const [name, since] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof since !== 'string') continue;
      const key = name.trim();
      if (!key) continue;
      if (
        !(key in merged) ||
        new Date(since).getTime() < new Date(merged[key]).getTime()
      ) {
        merged[key] = since;
      }
    }
    await queryRunner.query(
      `UPDATE "app_settings" SET value = $1 WHERE key = 'livetv_restricted_groups_vanished'`,
      [JSON.stringify(merged)],
    );
  }
}
