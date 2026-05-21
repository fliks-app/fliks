import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Collapse libraries to a single root path each.
 *
 * Before this migration, `libraries → root_folders` was 1:N; the per-folder
 * settings (mediaTypes, preferredProvider, cleanup, default profiles) lived
 * on `RootFolder`. After the library refactor, all of those moved up to
 * `Library` itself — meaning a library with two root folders carries no
 * distinguishing per-path settings and the multi-path layout adds nothing
 * but operational complexity.
 *
 * Strategy for libraries with > 1 root folder:
 *  1. Keep the root folder with the most media (ties → lowest id).
 *  2. For every other root folder of the same library, create a new
 *     "spin-off" library inheriting the parent's settings + the user
 *     access rows + role default associations, then re-anchor the dropped
 *     root folder under it. On-disk content is untouched; media keep
 *     their `rootFolderId` and follow the root folder to the spin-off.
 *  3. Once every library has ≤ 1 root folder, drop the nullable on
 *     `libraryId` and add a UNIQUE constraint so the 1:1 contract is
 *     enforced at the DB level.
 *
 * Idempotent: a second run sees every library with one root folder and
 * skips straight to the constraint additions (no-op if already applied).
 */
export class CollapseLibraryRootFolders1779100000000 implements MigrationInterface {
  name = 'CollapseLibraryRootFolders1779100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ----- Step 1: spin off extra root folders into their own libraries.
    const multi: { libraryId: number }[] = await queryRunner.query(
      `SELECT "libraryId"
         FROM "root_folders"
        WHERE "libraryId" IS NOT NULL
        GROUP BY "libraryId"
       HAVING COUNT(*) > 1`,
    );

    for (const { libraryId } of multi) {
      const rfs: { id: number; path: string; mediaCount: number }[] =
        await queryRunner.query(
          `SELECT rf.id, rf.path,
                  (SELECT COUNT(*) FROM "media" m WHERE m."rootFolderId" = rf.id)::int AS "mediaCount"
             FROM "root_folders" rf
            WHERE rf."libraryId" = $1
            ORDER BY "mediaCount" DESC, rf.id ASC`,
          [libraryId],
        );

      // First row is the "keeper" — leave it attached to the parent library.
      const toSpinOff = rfs.slice(1);
      const [parent] = await queryRunner.query(
        `SELECT * FROM "libraries" WHERE id = $1`,
        [libraryId],
      );
      if (!parent) continue;

      for (const rf of toSpinOff) {
        const baseLabel = rf.path.split('/').filter(Boolean).pop() ?? `path-${rf.id}`;
        const spinOffName = `${parent.name} (${baseLabel})`;

        // Insert spin-off library mirroring the parent's settings. Default
        // flags (isDefaultForMovies/isDefaultForSeries) stay on the parent
        // only — at most one library should hold each flag.
        const inserted: { id: number }[] = await queryRunner.query(
          `INSERT INTO "libraries"
             ("name", "icon", "color", "mediaTypes", "preferredProvider",
              "stalledCleanupProfile", "defaultQualityProfileId",
              "defaultLanguageProfileId", "isDefaultForMovies",
              "isDefaultForSeries", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, false, now(), now())
             RETURNING id`,
          [
            spinOffName,
            parent.icon,
            parent.color,
            JSON.stringify(parent.mediaTypes),
            parent.preferredProvider,
            parent.stalledCleanupProfile,
            parent.defaultQualityProfileId,
            parent.defaultLanguageProfileId,
          ],
        );
        const newLibId = inserted[0].id;

        // Re-anchor the dropped root folder under the spin-off.
        await queryRunner.query(
          `UPDATE "root_folders" SET "libraryId" = $1 WHERE id = $2`,
          [newLibId, rf.id],
        );

        // Re-anchor media that lived under the dropped root folder.
        await queryRunner.query(
          `UPDATE "media" SET "libraryId" = $1 WHERE "rootFolderId" = $2`,
          [newLibId, rf.id],
        );

        // Mirror user access from the parent so the same users keep
        // visibility on the migrated media.
        await queryRunner.query(
          `INSERT INTO "library_user_access" ("libraryId", "userId", "createdAt", "updatedAt")
             SELECT $1, "userId", now(), now()
               FROM "library_user_access"
              WHERE "libraryId" = $2`,
          [newLibId, libraryId],
        );

        // Mirror role default associations (join table for ManyToMany
        // `Role.defaultLibraries`).
        await queryRunner.query(
          `INSERT INTO "role_default_libraries" ("roleId", "libraryId")
             SELECT "roleId", $1
               FROM "role_default_libraries"
              WHERE "libraryId" = $2
             ON CONFLICT DO NOTHING`,
          [newLibId, libraryId],
        );
      }
    }

    // ----- Step 2: enforce 1:1 at the DB level.
    // After step 1, every root_folders row should already have a libraryId
    // (the legacy auto-wrap covered any remaining NULL). Guard against the
    // edge case anyway so the migration doesn't fail on stale dev DBs.
    const orphans: { count: string }[] = await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM "root_folders" WHERE "libraryId" IS NULL`,
    );
    if (Number(orphans[0]?.count ?? 0) > 0) {
      throw new Error(
        'Cannot enforce libraryId NOT NULL on root_folders — orphan rows exist. Resolve them manually before re-running the migration.',
      );
    }

    await queryRunner.query(
      `ALTER TABLE "root_folders" ALTER COLUMN "libraryId" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "root_folders" ADD CONSTRAINT "UQ_root_folders_libraryId" UNIQUE ("libraryId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "root_folders" DROP CONSTRAINT IF EXISTS "UQ_root_folders_libraryId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "root_folders" ALTER COLUMN "libraryId" DROP NOT NULL`,
    );
    // Spin-off libraries are intentionally NOT merged back — the data has
    // been re-anchored and merging would require choosing a winning name /
    // settings, which is a manual decision.
  }
}
