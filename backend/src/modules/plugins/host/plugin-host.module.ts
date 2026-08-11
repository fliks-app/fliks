import { Global, Module } from '@nestjs/common';
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
import { PluginHostBindingService } from './plugin-host-binding.service';
import { PluginCountsCacheModule } from './plugin-counts-cache.module';
import { PLUGIN_HOST_PLUGIN_ID } from './plugin-host.constants';

/**
 * Wires `FliksHostImpl` — core's implementation of the 15 plugin-facing host
 * methods — the in-process client, and `PluginHostBindingService`, which the
 * supervisor uses to get a `PluginHostApi` scoped to one plugin's registration.
 * `EventsService`/`SseAudienceService` come for free from the `@Global()`
 * `EventsModule`, so they aren't imported here.
 *
 * `@Global()` for the same reason: this module reaches `MediaModule`, which
 * (via `FliksSchedulerModule`) reaches `PluginsModule` — importing this module
 * from `PluginsModule` would close that loop into a cycle. Global-scoping
 * exports the binding service without adding that edge.
 */
@Global()
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
    PluginHostBindingService,
  ],
  exports: [
    FliksHostImpl,
    InProcessPluginHostClient,
    PluginHostBindingService,
    PluginCountsCacheModule,
  ],
})
export class PluginHostModule {}
