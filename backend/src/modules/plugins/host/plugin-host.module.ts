import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Media } from '../../media/entities/media.entity';
import { Season } from '../../media/entities/season.entity';
import { Episode } from '../../media/entities/episode.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import { PluginRegistration } from '../entities/plugin-registration.entity';
import { MediaModule } from '../../media/media.module';
import { ProfilesModule } from '../../profiles/profiles.module';
import { RequestsModule } from '../../requests/requests.module';
import { LibraryIngestModule } from '../../../common/library-ingest/library-ingest.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { MediaServersModule } from '../../media-servers/media-servers.module';
import { SettingsModule } from '../../settings/settings.module';
import { FliksHostImpl } from './fliks-host.service';
import { InProcessPluginHostClient } from './in-process-plugin-host-client';
import { PluginCountsCacheModule } from './plugin-counts-cache.module';
import { PLUGIN_HOST_PLUGIN_ID } from './plugin-host.constants';

/**
 * Wires `FliksHostImpl` — core's implementation of the 15 plugin-facing host
 * methods — and the in-process client that stands in for the RPC transport
 * until Phase 10.4. `EventsService`/`SseAudienceService` come for free from
 * the `@Global()` `EventsModule`, so they aren't imported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Media,
      Season,
      Episode,
      MediaFile,
      PluginRegistration,
    ]),
    MediaModule,
    ProfilesModule,
    RequestsModule,
    LibraryIngestModule,
    NotificationsModule,
    MediaServersModule,
    SettingsModule,
    PluginCountsCacheModule,
  ],
  providers: [
    { provide: PLUGIN_HOST_PLUGIN_ID, useValue: null },
    FliksHostImpl,
    InProcessPluginHostClient,
  ],
  exports: [FliksHostImpl, InProcessPluginHostClient, PluginCountsCacheModule],
})
export class PluginHostModule {}
