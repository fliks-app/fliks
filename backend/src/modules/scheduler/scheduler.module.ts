import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Command } from './entities/command.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { SchedulerService } from './scheduler.service';
import { CompletionService } from './completion.service';
import { AcquisitionEventsService } from './acquisition-events.service';
import { NamingService } from './naming.service';
import { BackupService } from './backup.service';
import { LogBufferService } from './log-buffer.service';
import { UpdateCheckService } from './update-check.service';
import { CommandsController } from './commands.controller';
import { SystemController } from './system.controller';
import { LivenessController } from './liveness.controller';
import { IndexersModule } from '../indexers/indexers.module';
import { DownloadClientsModule } from '../download-clients/download-clients.module';
import { MetadataProvidersModule } from '../metadata-providers/metadata-providers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MediaModule } from '../media/media.module';
import { AuthModule } from '../auth/auth.module';
import { BlocklistModule } from '../blocklist/blocklist.module';
import { DelayProfile } from '../profiles/entities/delay-profile.entity';
import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { SubtitlesModule } from '../subtitles/subtitles.module';
import { SettingsModule } from '../settings/settings.module';
import { MediaServersModule } from '../media-servers/media-servers.module';
import { StreamingModule } from '../streaming/streaming.module';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { StalledCheck } from './entities/stalled-check.entity';
import { CleanupProfilesModule } from '../cleanup-profiles/cleanup-profiles.module';
import { LibrariesModule } from '../libraries/libraries.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { MarkersModule } from '../markers/markers.module';
import { Library } from '../libraries/entities/library.entity';
import { LibraryIngestModule } from '../../common/library-ingest/library-ingest.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      Command,
      FliksRequest,
      Media,
      MediaFile,
      DownloadHistory,
      Season,
      Episode,
      Indexer,
      DownloadClient,
      DelayProfile,
      QualityProfile,
      SubtitleFile,
      StalledCheck,
      Library,
    ]),
    IndexersModule,
    // forwardRef: DownloadClientsModule now imports this module back for
    // SchedulerService (block-torrent re-search).
    forwardRef(() => DownloadClientsModule),
    MetadataProvidersModule,
    NotificationsModule,
    forwardRef(() => MediaModule),
    AuthModule,
    BlocklistModule,
    SubtitlesModule,
    SettingsModule,
    MediaServersModule,
    StreamingModule,
    CleanupProfilesModule,
    LibrariesModule,
    ProfilesModule,
    MarkersModule,
    forwardRef(() => LibraryIngestModule),
  ],
  controllers: [CommandsController, SystemController, LivenessController],
  providers: [
    SchedulerService,
    CompletionService,
    AcquisitionEventsService,
    NamingService,
    BackupService,
    LogBufferService,
    UpdateCheckService,
    SubtitleSchedulerService,
  ],
  exports: [
    SchedulerService,
    CompletionService,
    AcquisitionEventsService,
    NamingService,
    LogBufferService,
    SubtitleSchedulerService,
  ],
})
export class FliksSchedulerModule {}
