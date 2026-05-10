import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Until now `resolveLanguageProfileIdForImport` could return null, leaving
 * `media.languageProfileId` unset. We now require a language profile on
 * every media (mirror of the quality-profile rule). Seed the default
 * profile if none exists, then attribute it to every orphan media row.
 */
export class BackfillMediaLanguageProfile1778300000000
  implements MigrationInterface
{
  name = 'BackfillMediaLanguageProfile1778300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [existing] = await queryRunner.query(
      `SELECT COUNT(*)::int AS c FROM "language_profiles"`,
    );
    if ((existing?.c ?? 0) === 0) {
      await queryRunner.query(
        `INSERT INTO "language_profiles"
           ("name", "audioLanguages", "subtitleLanguages", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, now(), now())`,
        ['Toutes les langues (défaut)', '[]', '[]'],
      );
    }
    await queryRunner.query(
      `UPDATE "media"
          SET "languageProfileId" = (
            SELECT id FROM "language_profiles" ORDER BY id ASC LIMIT 1
          )
        WHERE "languageProfileId" IS NULL`,
    );
  }

  public async down(): Promise<void> {
    // No rollback: we don't know which medias originally had no profile.
  }
}
