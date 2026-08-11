import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Command } from './entities/command.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { Indexer } from '../../plugins/download/indexers/entities/indexer.entity';
import { DownloadClient } from '../../plugins/download/download-clients/entities/download-client.entity';
import { SchedulerService } from './scheduler.service';
import { NamingService } from './naming.service';
import { BackupService } from './backup.service';
import { LogBufferModule } from './log-buffer.module';
import { UpdateCheckService } from './update-check.service';
import { CommandsController } from './commands.controller';
import { SystemController } from './system.controller';
import { LivenessController } from './liveness.controller';
import { IndexersModule } from '../../plugins/download/indexers/indexers.module';
import { DownloadClientsModule } from '../../plugins/download/download-clients/download-clients.module';
import { MetadataProvidersModule } from '../metadata-providers/metadata-providers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MediaModule } from '../media/media.module';
import { AuthModule } from '../auth/auth.module';
import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { SubtitlesModule } from '../subtitles/subtitles.module';
import { SettingsModule } from '../settings/settings.module';
import { MediaServersModule } from '../media-servers/media-servers.module';
import { StreamingModule } from '../streaming/streaming.module';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { MarkersModule } from '../markers/markers.module';
import { Library } from '../libraries/entities/library.entity';
import { PluginsModule } from '../plugins/plugins.module';
import { ScheduledJobRegistryModule } from './scheduled-job-registry.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      Command,
      FliksRequest,
      Media,
      MediaFile,
      Episode,
      Indexer,
      DownloadClient,
      SubtitleFile,
      Library,
    ]),
    IndexersModule,
    // forwardRef: SystemController's client health-check needs DownloadClientsModule,
    // which imports BlocklistModule — unrelated to the acquisition bundle.
    forwardRef(() => DownloadClientsModule),
    MetadataProvidersModule,
    NotificationsModule,
    forwardRef(() => MediaModule),
    AuthModule,
    SubtitlesModule,
    SettingsModule,
    MediaServersModule,
    StreamingModule,
    MarkersModule,
    LogBufferModule,
    // Already reachable transitively via IndexersModule -> PluginsModule (see
    // LogBufferModule's own doc comment); imported directly here so SchedulerService can
    // inject PluginJobsService for the merged job listing.
    PluginsModule,
    ScheduledJobRegistryModule,
  ],
  controllers: [CommandsController, SystemController, LivenessController],
  providers: [
    SchedulerService,
    NamingService,
    BackupService,
    UpdateCheckService,
    SubtitleSchedulerService,
  ],
  exports: [
    SchedulerService,
    NamingService,
    LogBufferModule,
    SubtitleSchedulerService,
  ],
})
export class FliksSchedulerModule {}
