import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Command } from './entities/command.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { LogBufferModule } from './log-buffer.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { JobsBridgeController } from './jobs-bridge.controller';
import { LibrariesModule } from '../libraries/libraries.module';
import { SettingsModule } from '../settings/settings.module';
import { StreamingModule } from '../streaming/streaming.module';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { SubtitleBlacklist } from '../subtitles/entities/subtitle-blacklist.entity';
import { SubtitleProvider } from '../subtitles/entities/subtitle-provider.entity';
import { SubtitleProviderStat } from '../subtitles/entities/subtitle-provider-stat.entity';
import { TranslationProvider } from '../subtitles/entities/translation-provider.entity';
import { Library } from '../libraries/entities/library.entity';
import { PluginsModule } from '../plugins/plugins.module';
import { ScheduledJobRegistryModule } from './scheduled-job-registry.module';
import { LiveTvModule } from '../livetv/livetv.module';
import { QoeModule } from '../qoe/qoe.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      Command,
      FliksRequest,
      Media,
      MediaFile,
      Episode,
      // fliks-server owns subtitles; the entities stay registered until S9 for the relations that remain.
      SubtitleFile,
      SubtitleBlacklist,
      SubtitleProvider,
      SubtitleProviderStat,
      TranslationProvider,
      Library,
    ]),
    NotificationsModule,
    AuthModule,
    LibrariesModule,
    SettingsModule,
    StreamingModule,
    LogBufferModule,
    // Imported directly so the jobs bridge can reach the plugin job and catalog services.
    PluginsModule,
    ScheduledJobRegistryModule,
    LiveTvModule,
    QoeModule,
  ],
  controllers: [JobsBridgeController],
  exports: [LogBufferModule],
})
export class FliksSchedulerModule {}
