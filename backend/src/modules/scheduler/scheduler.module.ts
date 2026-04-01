import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Command } from './entities/command.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { RemotePathMapping } from '../settings/entities/remote-path-mapping.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { SchedulerService } from './scheduler.service';
import { CompletionService } from './completion.service';
import { NamingService } from './naming.service';
import { BackupService } from './backup.service';
import { LogBufferService } from './log-buffer.service';
import { EventsService } from './events.service';
import { ImportRadarrService } from './import-radarr.service';
import { ImportSonarrService } from './import-sonarr.service';
import { CommandsController } from './commands.controller';
import { SystemController } from './system.controller';
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
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      Command,
      Media,
      MediaFile,
      DownloadHistory,
      Season,
      Episode,
      Indexer,
      DownloadClient,
      RootFolder,
      DelayProfile,
      RemotePathMapping,
      QualityProfile,
      SubtitleFile,
    ]),
    IndexersModule,
    DownloadClientsModule,
    MetadataProvidersModule,
    NotificationsModule,
    MediaModule,
    AuthModule,
    BlocklistModule,
    SubtitlesModule,
    SettingsModule,
  ],
  controllers: [CommandsController, SystemController],
  providers: [
    SchedulerService,
    CompletionService,
    NamingService,
    BackupService,
    LogBufferService,
    EventsService,
    ImportRadarrService,
    ImportSonarrService,
    SubtitleSchedulerService,
  ],
  exports: [
    SchedulerService,
    CompletionService,
    NamingService,
    LogBufferService,
    EventsService,
    SubtitleSchedulerService,
  ],
})
export class SuitarrSchedulerModule {}
