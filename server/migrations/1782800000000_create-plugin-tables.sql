
      CREATE TYPE "plugin_packages_origin_enum" AS ENUM ('catalog', 'manual');


      CREATE TYPE "plugin_packages_status_enum" AS ENUM ('active', 'failed');


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
      );


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
      );


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
      );
