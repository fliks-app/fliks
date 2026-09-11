import { MigrationInterface, QueryRunner } from 'typeorm';

/** Every install seeded `minSize` at 0, which disabled the SIZE_TOO_LOW rule outright and let
 *  extras indexed under a feature's name through. Only rows still at 0 move, so a tuned floor
 *  survives. */
const MIN_BY_QUALITY_ID: Record<number, number> = {
  11: 150, // HDTV-720p
  12: 150, // WEBDL-720p
  13: 150, // WEBRip-720p
  14: 250, // Bluray-720p
  15: 250, // HDTV-1080p
  16: 250, // WEBDL-1080p
  17: 250, // WEBRip-1080p
  18: 400, // Bluray-1080p
  19: 8000, // Remux-1080p
  20: 600, // HDTV-2160p
  21: 600, // WEBDL-2160p
  22: 600, // WEBRip-2160p
  23: 1000, // Bluray-2160p
  24: 15000, // Remux-2160p
};

export class QualityDefinitionMinSizes1785000000000
  implements MigrationInterface
{
  name = 'QualityDefinitionMinSizes1785000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [qualityId, min] of Object.entries(MIN_BY_QUALITY_ID)) {
      await queryRunner.query(
        `UPDATE "quality_definitions" SET "minSize" = $1 WHERE "qualityId" = $2 AND "minSize" = 0`,
        [min, Number(qualityId)],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "quality_definitions" SET "minSize" = 0 WHERE "qualityId" = ANY($1)`,
      [Object.keys(MIN_BY_QUALITY_ID).map(Number)],
    );
  }
}
