import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sidecars the player can't render (`.sub`, `.mks`, `.smi`, `.sami`) were
 * stored with a null codec, so the client listed them as text. Discovery no
 * longer creates them; drop the rows (never the files). A `.sub` next to its
 * `.idx` is VobSub: the next rescan re-creates it with the right codec, which
 * avoids a filesystem check from a migration (mounts may be absent at boot).
 */
export class DropUnrenderableSidecarSubtitles1786200000000 implements MigrationInterface {
  name = 'DropUnrenderableSidecarSubtitles1786200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "subtitle_files"
       WHERE "codec" IS NULL AND "relativePath" ~* '\\.(sub|mks|smi|sami)$'`,
    );
  }

  public async down(): Promise<void> {
    // Rows are re-created by discovery where renderable.
  }
}
