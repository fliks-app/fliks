import { MigrationInterface, QueryRunner } from 'typeorm';

/** The three tables plugin state lives in.
 *  All three are new and empty on upgrade. */
export class CreatePluginTables1782800000000 implements MigrationInterface {
  name = 'CreatePluginTables1782800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "plugin_packages_origin_enum" AS ENUM ('catalog', 'manual')
    `);
    await queryRunner.query(`
      CREATE TYPE "plugin_packages_status_enum" AS ENUM ('active', 'failed')
    `);
    await queryRunner.query(`
      CREATE TABLE "plugin_packages" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "pluginId" varchar NOT NULL,
        "version" varchar NOT NULL,
        "archive" bytea NOT NULL,
        "origin" "plugin_packages_origin_enum" NOT NULL,
        "signature" varchar NOT NULL,
        "verifiedByKeyId" varchar,
        "manifest" jsonb NOT NULL,
        "status" "plugin_packages_status_enum" NOT NULL DEFAULT 'active',
        CONSTRAINT "UQ_plugin_packages_pluginId" UNIQUE ("pluginId")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "plugin_sources" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "url" varchar NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "publicKey" bytea,
        "lastRefreshedAt" timestamptz,
        "lastRefreshError" text,
        "cachedCatalog" jsonb
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "plugin_registrations" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "pluginId" varchar NOT NULL,
        "ingestRoots" text[] NOT NULL DEFAULT '{}',
        "scopes" text[] NOT NULL DEFAULT '{}',
        "enabled" boolean NOT NULL DEFAULT true,
        "manifest" jsonb NOT NULL,
        CONSTRAINT "UQ_plugin_registrations_pluginId" UNIQUE ("pluginId")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "plugin_registrations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "plugin_sources"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "plugin_packages"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "plugin_packages_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "plugin_packages_origin_enum"`);
  }
}
