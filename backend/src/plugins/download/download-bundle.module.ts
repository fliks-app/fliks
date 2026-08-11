import { Module, OnModuleInit } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CronExpression } from '@nestjs/schedule';
import { Media } from '../../modules/media/entities/media.entity';
import { Season } from '../../modules/media/entities/season.entity';
import { Episode } from '../../modules/media/entities/episode.entity';
import { DelayProfile } from '../../modules/profiles/entities/delay-profile.entity';
import { Library } from '../../modules/libraries/entities/library.entity';
import { Command } from '../../modules/scheduler/entities/command.entity';
import { IndexersModule } from './indexers/indexers.module';
import { DownloadClientsModule } from './download-clients/download-clients.module';
import { Indexer } from './indexers/entities/indexer.entity';
import { DownloadClient } from './download-clients/entities/download-client.entity';
import { QbittorrentService } from './download-clients/qbittorrent.service';
import { MediaModule } from '../../modules/media/media.module';
import { ProfilesModule } from '../../modules/profiles/profiles.module';
import { BlocklistModule } from './blocklist/blocklist.module';
import { SettingsModule } from '../../modules/settings/settings.module';
import { StreamingModule } from '../../modules/streaming/streaming.module';
import { MarkersModule } from '../../modules/markers/markers.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { MediaServersModule } from '../../modules/media-servers/media-servers.module';
import { LibraryIngestModule } from '../../common/library-ingest/library-ingest.module';
import { PluginHostModule } from '../../modules/plugins/host/plugin-host.module';
import { ScheduledJobRegistryModule } from '../../modules/scheduler/scheduled-job-registry.module';
import { ScheduledJobRegistry } from '../../modules/scheduler/scheduled-job-registry.service';
import { ChecklistItemRegistryModule } from '../../modules/setup-checklist/checklist-item-registry.module';
import { ChecklistItemRegistry } from '../../modules/setup-checklist/checklist-item-registry.service';
import { NamingService } from '../../modules/scheduler/naming.service';
import { CompletionService } from './completion.service';
import { AcquisitionSchedulerService } from './acquisition-scheduler.service';
import { AutoGrabExecutorService } from './auto-grab-pipeline.service';
import { TorrentAutoMatcher } from './torrent-auto-matcher.service';
import { AcquisitionEventsService } from './acquisition-events.service';

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
    ChecklistItemRegistryModule,
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
    private readonly checklistItems: ChecklistItemRegistry,
    private readonly completion: CompletionService,
    private readonly acquisitionScheduler: AcquisitionSchedulerService,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(DownloadClient)
    private readonly downloadClientRepo: Repository<DownloadClient>,
    private readonly qbittorrent: QbittorrentService,
  ) {}

  /** Cron strings mirror the `@Cron` decorators on the services below — this
   *  only supplies metadata + the manual-trigger action, never the timing. */
  onModuleInit(): void {
    this.registry.register([
      {
        name: 'SearchMissing',
        cron: CronExpression.EVERY_6_HOURS,
        triggerable: true,
        labelKey: 'system.cmd_search_missing',
        run: () => this.acquisitionScheduler.searchMissing(),
      },
      {
        name: 'RssSync',
        cron: '*/15 * * * *',
        triggerable: true,
        labelKey: 'system.cmd_rss_sync',
        run: () => this.acquisitionScheduler.rssSync(),
      },
      {
        name: 'ImportCompleted',
        cron: CronExpression.EVERY_MINUTE,
        triggerable: true,
        labelKey: 'system.cmd_import_completed',
        run: () => this.completion.processCompleted(),
      },
      {
        name: 'CleanStalled',
        cron: CronExpression.EVERY_5_MINUTES,
        triggerable: true,
        labelKey: 'system.cmd_clean_stalled',
        run: () => this.completion.cleanStalledTorrents(),
      },
      {
        name: 'CleanSeeded',
        cron: CronExpression.EVERY_5_MINUTES,
        triggerable: true,
        labelKey: 'system.cmd_clean_seeded',
        run: () => this.completion.cleanSeededTorrents(),
      },
    ]);

    this.checklistItems.register([
      {
        key: 'indexer',
        severity: 'required',
        route: ['/admin', 'settings', 'indexers'],
        check: async () =>
          (await this.indexerRepo.count({ where: { enabled: true } })) > 0,
      },
      {
        key: 'download-client',
        severity: 'required',
        route: ['/admin', 'settings', 'download-clients'],
        check: async () =>
          (await this.downloadClientRepo.count({ where: { enabled: true } })) >
          0,
      },
    ]);
  }
}
