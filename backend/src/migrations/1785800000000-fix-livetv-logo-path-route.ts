import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Channel logos moved from the generic image route to a Live TV route with
 * its own access check (`fix(livetv): report full access, exemptions and
 * gate channel logos`), which dropped `livetv` from the image controller.
 * Any `logoPath` cached under the old route 404s forever: nothing re-derives
 * it from a local path, only from a remote URL.
 */
export class FixLivetvLogoPathRoute1785800000000 implements MigrationInterface {
  name = 'FixLivetvLogoPathRoute1785800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "livetv_channels"
       SET "logoPath" = regexp_replace("logoPath", '^/api/images/livetv/(\\d+)$', '/api/livetv/channels/\\1/logo')
       WHERE "logoPath" ~ '^/api/images/livetv/\\d+$'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "livetv_channels"
       SET "logoPath" = regexp_replace("logoPath", '^/api/livetv/channels/(\\d+)/logo$', '/api/images/livetv/\\1')
       WHERE "logoPath" ~ '^/api/livetv/channels/\\d+/logo$'`,
    );
  }
}
