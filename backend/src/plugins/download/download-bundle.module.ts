import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CronExpression } from '@nestjs/schedule';
import { Media } from '../../modules/media/entities/media.entity';
import { Season } from '../../modules/media/entities/season.entity';
import { Episode } from '../../modules/media/entities/episode.entity';
import { DelayProfile } from '../../modules/profiles/entities/delay-profile.entity';
import { Library } from '../../modules/libraries/entities/library.entity';
import { Command } from '../../modules/scheduler/entities/command.entity';
import { IndexersModule } from './indexers/indexers.module';
import { DownloadClientsModule } from './download-clients/download-clients.module';
import { MediaModule } from '../../modules/media/media.module';
import { ProfilesModule } from '../../modules/profiles/profiles.module';
import { BlocklistModule } from '../../modules/blocklist/blocklist.module';
import { SettingsModule } from '../../modules/settings/settings.module';
import { StreamingModule } from '../../modules/streaming/streaming.module';
import { MarkersModule } from '../../modules/markers/markers.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { MediaServersModule } from '../../modules/media-servers/media-servers.module';
import { LibraryIngestModule } from '../../common/library-ingest/library-ingest.module';
import { PluginHostModule } from '../../modules/plugins/host/plugin-host.module';
import { ScheduledJobRegistryModule } from '../../modules/scheduler/scheduled-job-registry.module';
import { ScheduledJobRegistry } from '../../modules/scheduler/scheduled-job-registry.service';
import { NamingService } from '../../modules/scheduler/naming.service';
import { CompletionService } from './completion.service';
import { AcquisitionSchedulerService } from './acquisition-scheduler.service';
import { AutoGrabExecutorService } from './auto-grab-pipeline.service';
import { TorrentAutoMatcher } from './torrent-auto-matcher.service';
import { AcquisitionEventsService } from '../../modules/scheduler/acquisition-events.service';

/**
 * Everything `FLIKS_BUNDLES` gates for acquisition: the four services core's
 * scheduler used to host, plus their host-client access. Registered directly
 * from `app.module.ts`, never from `FliksSchedulerModule` — that module sits
 * inside a `forwardRef` triangle with `MediaModule`/`LibraryIngestModule`, and
 * a plain import added there resolves undefined mid-cycle. Sitting beside it
 * instead of inside it is what makes the host client injectable here at all.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Media,
      Season,
      Episode,
      DelayProfile,
      Library,
      Command,
    ]),
    IndexersModule,
    DownloadClientsModule,
    MediaModule,
    ProfilesModule,
    BlocklistModule,
    SettingsModule,
    StreamingModule,
    MarkersModule,
    NotificationsModule,
    MediaServersModule,
    LibraryIngestModule,
    PluginHostModule,
    ScheduledJobRegistryModule,
  ],
  providers: [
    NamingService,
    AcquisitionEventsService,
    CompletionService,
    AcquisitionSchedulerService,
    AutoGrabExecutorService,
    TorrentAutoMatcher,
  ],
})
export class DownloadBundleModule implements OnModuleInit {
  constructor(
    private readonly registry: ScheduledJobRegistry,
    private readonly completion: CompletionService,
    private readonly acquisitionScheduler: AcquisitionSchedulerService,
  ) {}

  /** Cron strings mirror the `@Cron` decorators on the services below — this
   *  only supplies metadata + the manual-trigger action, never the timing. */
  onModuleInit(): void {
    this.registry.register([
      {
        name: 'SearchMissing',
        cron: CronExpression.EVERY_6_HOURS,
        triggerable: true,
        run: () => this.acquisitionScheduler.searchMissing(),
      },
      {
        name: 'RssSync',
        cron: '*/15 * * * *',
        triggerable: true,
        run: () => this.acquisitionScheduler.rssSync(),
      },
      {
        name: 'ImportCompleted',
        cron: CronExpression.EVERY_MINUTE,
        triggerable: true,
        run: () => this.completion.processCompleted(),
      },
      {
        name: 'CleanStalled',
        cron: CronExpression.EVERY_5_MINUTES,
        triggerable: true,
        run: () => this.completion.cleanStalledTorrents(),
      },
      {
        name: 'CleanSeeded',
        cron: CronExpression.EVERY_5_MINUTES,
        triggerable: true,
        run: () => this.completion.cleanSeededTorrents(),
      },
    ]);
  }
}
