import { MigrationInterface, QueryRunner } from 'typeorm';

// Acquisition moves to a plugin that owns its own schema. No FK from outside
// the set points in, so one multi-table drop resolves the intra-set keys —
// deliberately no CASCADE, so an unexpected outside dependency aborts loudly.
export class DropAcquisitionTables1783300000000 implements MigrationInterface {
  name = 'DropAcquisitionTables1783300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE "indexer_stats", "download_history", "blocklist", "stalled_checks", "download_clients", "indexers"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "indexers" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "name" varchar NOT NULL,
        "implementation" varchar NOT NULL,
        "settings" jsonb NOT NULL DEFAULT '{}',
        "enableRss" boolean NOT NULL DEFAULT true,
        "enableSearch" boolean NOT NULL DEFAULT true,
        "priority" integer NOT NULL DEFAULT 25,
        "enabled" boolean NOT NULL DEFAULT true,
        "capsMovieSearch" boolean NOT NULL DEFAULT false,
        "capsTvSearch" boolean NOT NULL DEFAULT false,
        "capsSearchFallback" boolean NOT NULL DEFAULT false,
        "requestDelay" integer NOT NULL DEFAULT 2
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "download_clients" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "name" varchar NOT NULL,
        "implementation" varchar NOT NULL,
        "settings" jsonb NOT NULL DEFAULT '{}',
        "enabled" boolean NOT NULL DEFAULT true,
        "priority" integer NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "stalled_checks" (
        "id" SERIAL PRIMARY KEY,
        "torrentHash" varchar(64) NOT NULL,
        "downloadedBytes" bigint NOT NULL,
        "checkedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_stalled_checks_torrentHash_checkedAt" ON "stalled_checks" ("torrentHash", "checkedAt")`,
    );
    await queryRunner.query(`
      CREATE TABLE "indexer_stats" (
        "id" SERIAL PRIMARY KEY,
        "queryDate" TIMESTAMP NOT NULL DEFAULT now(),
        "queryType" varchar NOT NULL DEFAULT 'search',
        "responseTimeMs" integer NOT NULL DEFAULT 0,
        "resultCount" integer NOT NULL DEFAULT 0,
        "errorMessage" text,
        "indexerId" integer,
        CONSTRAINT "FK_indexer_stats_indexerId" FOREIGN KEY ("indexerId") REFERENCES "indexers"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "download_history" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "sourceTitle" varchar NOT NULL,
        "quality" varchar NOT NULL,
        "language" varchar,
        "torrentHash" varchar,
        "status" varchar NOT NULL DEFAULT 'grabbed',
        "statusMessage" text,
        "grabSource" varchar(8) NOT NULL DEFAULT 'auto',
        "mediaId" integer,
        "indexerId" integer,
        "downloadClientId" integer,
        "episodeId" integer,
        "seasonId" integer,
        CONSTRAINT "FK_download_history_mediaId" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_download_history_episodeId" FOREIGN KEY ("episodeId") REFERENCES "episodes"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_download_history_seasonId" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_download_history_downloadClientId" FOREIGN KEY ("downloadClientId") REFERENCES "download_clients"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_download_history_indexerId" FOREIGN KEY ("indexerId") REFERENCES "indexers"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_download_history_torrentHash" ON "download_history" (lower("torrentHash")) WHERE "torrentHash" IS NOT NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE "blocklist" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "sourceTitle" varchar NOT NULL,
        "indexerName" varchar,
        "downloadUrl" varchar,
        "quality" varchar,
        "note" varchar,
        "indexerId" integer,
        "mediaId" integer,
        "userId" integer,
        CONSTRAINT "FK_blocklist_mediaId" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_blocklist_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_blocklist_sourceTitle_lower" ON "blocklist" (lower("sourceTitle"))`,
    );
  }
}
