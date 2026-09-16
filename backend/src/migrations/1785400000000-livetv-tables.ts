import { MigrationInterface, QueryRunner } from "typeorm";

export class LivetvTables1785400000000 implements MigrationInterface {
    name = 'LivetvTables1785400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "livetv_sources" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying NOT NULL, "kind" character varying(16) NOT NULL DEFAULT 'm3u', "url" text NOT NULL, "username" character varying, "password" character varying, "userAgent" character varying, "referer" character varying, "maxStreams" integer NOT NULL DEFAULT '0', "maxStreamsIsManual" boolean NOT NULL DEFAULT false, "refreshIntervalHours" integer NOT NULL DEFAULT '12', "includeGroupsPattern" text, "excludeGroupsPattern" text, "expiresAt" TIMESTAMP WITH TIME ZONE, "accountStatus" character varying, "guideUrls" jsonb NOT NULL DEFAULT '[]', "playlistEtag" character varying, "playlistLastModified" character varying, "enabled" boolean NOT NULL DEFAULT true, "priority" integer NOT NULL DEFAULT '0', "lastSyncAt" TIMESTAMP WITH TIME ZONE, "lastSyncStatus" character varying(16) NOT NULL DEFAULT 'never', "lastSyncError" text, "channelCount" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_d63908dc94a2a3e9c02f8307d8e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "livetv_channel_streams" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "externalId" character varying NOT NULL, "url" text NOT NULL, "priority" integer NOT NULL DEFAULT '0', "qualityLabel" character varying, "providerName" character varying NOT NULL, "userAgent" character varying, "referer" character varying, "lastSeenAt" TIMESTAMP WITH TIME ZONE, "probedVideoCodec" character varying(32), "probedAudioCodec" character varying(32), "probedContainer" character varying(64), "lastOkAt" TIMESTAMP WITH TIME ZONE, "lastError" text, "channelId" integer, "sourceId" integer, CONSTRAINT "PK_23d8433c02f6064c9c196423089" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_livetv_stream_source_external" ON "livetv_channel_streams" ("sourceId", "externalId") `);
        await queryRunner.query(`CREATE TABLE "livetv_channels" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying NOT NULL, "number" integer, "logoPath" text, "groupName" character varying, "enabled" boolean NOT NULL DEFAULT false, "sortIndex" integer NOT NULL DEFAULT '0', "guideChannelId" character varying, "guideMatchKind" character varying(16), "guideShiftMinutes" integer NOT NULL DEFAULT '0', "lastPlayedAt" TIMESTAMP WITH TIME ZONE, "lastErrorAt" TIMESTAMP WITH TIME ZONE, "consecutiveFailures" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_2e6f017729660b63bbc0de27db7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_livetv_channels_group" ON "livetv_channels" ("groupName") `);
        await queryRunner.query(`CREATE INDEX "IDX_livetv_channels_guide" ON "livetv_channels" ("guideChannelId") `);
        await queryRunner.query(`CREATE TABLE "livetv_user_channel_prefs" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "favorite" boolean NOT NULL DEFAULT false, "hidden" boolean NOT NULL DEFAULT false, "lastPlayedAt" TIMESTAMP WITH TIME ZONE, "userId" integer, "channelId" integer, CONSTRAINT "PK_5e7987b481758c46a49f0301a8d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_livetv_pref_user_channel" ON "livetv_user_channel_prefs" ("userId", "channelId") `);
        await queryRunner.query(`CREATE TABLE "livetv_guide_sources" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying NOT NULL, "kind" character varying(16) NOT NULL DEFAULT 'xmltv', "url" text, "refreshIntervalHours" integer NOT NULL DEFAULT '12', "timezoneOffsetMinutes" integer NOT NULL DEFAULT '0', "language" character varying(16), "priority" integer NOT NULL DEFAULT '0', "enabled" boolean NOT NULL DEFAULT true, "lastSyncAt" TIMESTAMP WITH TIME ZONE, "lastSyncStatus" character varying(16) NOT NULL DEFAULT 'never', "lastSyncError" text, "programCount" integer NOT NULL DEFAULT '0', "etag" character varying, "lastModified" character varying, "sourceId" integer, CONSTRAINT "PK_ef3aedcfce4e1a3e5c0f53f4aa6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "livetv_programs" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "guideChannelId" character varying NOT NULL, "startsAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endsAt" TIMESTAMP WITH TIME ZONE NOT NULL, "title" character varying NOT NULL, "subtitle" character varying, "description" text, "categories" jsonb NOT NULL DEFAULT '[]', "iconUrl" text, "seasonNumber" integer, "episodeNumber" integer, "seriesId" character varying, "isNew" boolean NOT NULL DEFAULT false, "isLive" boolean NOT NULL DEFAULT false, "rating" character varying(32), "year" integer, "guideSourceId" integer, CONSTRAINT "PK_270df4c18a60727a2340fbd97a2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_livetv_programs_source_channel_start" ON "livetv_programs" ("guideSourceId", "guideChannelId", "startsAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_livetv_programs_window" ON "livetv_programs" ("startsAt", "endsAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_livetv_programs_channel_start" ON "livetv_programs" ("guideChannelId", "startsAt") `);
        await queryRunner.query(`CREATE TABLE "livetv_guide_channels" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "channelId" character varying NOT NULL, "displayNames" jsonb NOT NULL DEFAULT '[]', "iconUrl" text, "guideSourceId" integer, CONSTRAINT "PK_91d0f326b295847759cd57ae98c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_livetv_guide_channel_source_id" ON "livetv_guide_channels" ("guideSourceId", "channelId") `);
        await queryRunner.query(`CREATE TABLE "livetv_group_access" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "groupName" character varying NOT NULL, "userId" integer, CONSTRAINT "PK_15800fff943da31cff821faabe6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_livetv_group_access_user_group" ON "livetv_group_access" ("userId", "groupName") `);
        await queryRunner.query(`ALTER TABLE "livetv_channel_streams" ADD CONSTRAINT "FK_59af5c2b4a5f3029361bda58aff" FOREIGN KEY ("channelId") REFERENCES "livetv_channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "livetv_channel_streams" ADD CONSTRAINT "FK_7c1c468ee5ade7295749ab9e1e9" FOREIGN KEY ("sourceId") REFERENCES "livetv_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "livetv_user_channel_prefs" ADD CONSTRAINT "FK_060071713679f7fee42720c6753" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "livetv_user_channel_prefs" ADD CONSTRAINT "FK_f4cc72c18df00113d4e17fa598c" FOREIGN KEY ("channelId") REFERENCES "livetv_channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "livetv_guide_sources" ADD CONSTRAINT "FK_e84c176ef1ef24a8c523d86bc95" FOREIGN KEY ("sourceId") REFERENCES "livetv_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "livetv_programs" ADD CONSTRAINT "FK_e286f77ce01c33b14526a8090d7" FOREIGN KEY ("guideSourceId") REFERENCES "livetv_guide_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "livetv_guide_channels" ADD CONSTRAINT "FK_9919469c4f149762ee9c3265564" FOREIGN KEY ("guideSourceId") REFERENCES "livetv_guide_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "livetv_group_access" ADD CONSTRAINT "FK_c8018529d697ca2f8b6db09a809" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "livetv_group_access" DROP CONSTRAINT "FK_c8018529d697ca2f8b6db09a809"`);
        await queryRunner.query(`ALTER TABLE "livetv_guide_channels" DROP CONSTRAINT "FK_9919469c4f149762ee9c3265564"`);
        await queryRunner.query(`ALTER TABLE "livetv_programs" DROP CONSTRAINT "FK_e286f77ce01c33b14526a8090d7"`);
        await queryRunner.query(`ALTER TABLE "livetv_guide_sources" DROP CONSTRAINT "FK_e84c176ef1ef24a8c523d86bc95"`);
        await queryRunner.query(`ALTER TABLE "livetv_user_channel_prefs" DROP CONSTRAINT "FK_f4cc72c18df00113d4e17fa598c"`);
        await queryRunner.query(`ALTER TABLE "livetv_user_channel_prefs" DROP CONSTRAINT "FK_060071713679f7fee42720c6753"`);
        await queryRunner.query(`ALTER TABLE "livetv_channel_streams" DROP CONSTRAINT "FK_7c1c468ee5ade7295749ab9e1e9"`);
        await queryRunner.query(`ALTER TABLE "livetv_channel_streams" DROP CONSTRAINT "FK_59af5c2b4a5f3029361bda58aff"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_livetv_group_access_user_group"`);
        await queryRunner.query(`DROP TABLE "livetv_group_access"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_livetv_guide_channel_source_id"`);
        await queryRunner.query(`DROP TABLE "livetv_guide_channels"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_livetv_programs_channel_start"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_livetv_programs_window"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_livetv_programs_source_channel_start"`);
        await queryRunner.query(`DROP TABLE "livetv_programs"`);
        await queryRunner.query(`DROP TABLE "livetv_guide_sources"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_livetv_pref_user_channel"`);
        await queryRunner.query(`DROP TABLE "livetv_user_channel_prefs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_livetv_channels_guide"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_livetv_channels_group"`);
        await queryRunner.query(`DROP TABLE "livetv_channels"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_livetv_stream_source_external"`);
        await queryRunner.query(`DROP TABLE "livetv_channel_streams"`);
        await queryRunner.query(`DROP TABLE "livetv_sources"`);
    }

}
