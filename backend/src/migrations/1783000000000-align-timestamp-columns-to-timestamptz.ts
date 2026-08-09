import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `createdAt`/`updatedAt` were synchronised as `timestamp` (no zone) because
 * `BaseEntity` never set an explicit column type; 9 hand-written tables
 * already used `timestamptz`. This aligns the rest.
 *
 * `AT TIME ZONE 'UTC'` is safe because both the backend and Postgres run in
 * UTC (no `TZ` override on either service), so every stored naive value
 * already represents a UTC instant — the cast attaches the zone, it never
 * shifts the clock.
 */
export class AlignTimestampColumnsToTimestamptz1783000000000
  implements MigrationInterface
{
  name = 'AlignTimestampColumnsToTimestamptz1783000000000';

  // timestamp -> timestamptz (BaseEntity tables that predate the explicit type)
  private readonly tables = [
    'app_settings',
    'auto_approval_rules',
    'blocklist',
    'commands',
    'custom_formats',
    'delay_profiles',
    'download_clients',
    'download_history',
    'episode_markers',
    'episodes',
    'indexers',
    'language_profiles',
    'libraries',
    'library_user_access',
    'media',
    'media_cast',
    'media_crew',
    'media_files',
    'media_metadata',
    'media_servers',
    'notification_connections',
    'pairing_requests',
    'persons',
    'playback_states',
    'plugin_packages',
    'plugin_registrations',
    'plugin_sources',
    'quality_definitions',
    'quality_profiles',
    'recommendation_dismissals',
    'request_comments',
    'requests',
    'roles',
    'seasons',
    'subtitle_blacklist',
    'subtitle_files',
    'subtitle_providers',
    'users',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC',
        ALTER COLUMN "updatedAt" TYPE timestamptz USING "updatedAt" AT TIME ZONE 'UTC'
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ALTER COLUMN "createdAt" TYPE timestamp USING "createdAt" AT TIME ZONE 'UTC',
        ALTER COLUMN "updatedAt" TYPE timestamp USING "updatedAt" AT TIME ZONE 'UTC'
      `);
    }
  }
}
