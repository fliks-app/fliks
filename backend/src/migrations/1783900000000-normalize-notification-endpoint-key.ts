import { MigrationInterface, QueryRunner } from 'typeorm';

/** The webhook, gotify and ntfy senders read `settings.url`; fold a stored
 *  `webhookUrl` onto it so existing connections resolve without a re-save. */
export class NormalizeNotificationEndpointKey1783900000000 implements MigrationInterface {
  name = 'NormalizeNotificationEndpointKey1783900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "notification_connections"
      SET "settings" = ("settings" - 'webhookUrl')
        || jsonb_build_object('url', "settings"->'webhookUrl')
      WHERE "type" IN ('webhook', 'gotify', 'ntfy')
        AND "settings" ? 'webhookUrl'
        AND NOT "settings" ? 'url'
    `);

    // A row carrying both keys kept `url` as the authoritative one above;
    // drop the now-redundant `webhookUrl` so only one endpoint remains.
    await queryRunner.query(`
      UPDATE "notification_connections"
      SET "settings" = "settings" - 'webhookUrl'
      WHERE "type" IN ('webhook', 'gotify', 'ntfy')
        AND "settings" ? 'webhookUrl'
    `);
  }

  /** Lossy: rows that already stored `url` before this migration are moved to
   *  `webhookUrl` too, since nothing records which ones `up()` converted. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "notification_connections"
      SET "settings" = ("settings" - 'url')
        || jsonb_build_object('webhookUrl', "settings"->'url')
      WHERE "type" IN ('webhook', 'gotify', 'ntfy')
        AND "settings" ? 'url'
    `);
  }
}
