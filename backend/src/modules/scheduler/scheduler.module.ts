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
import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { JobsBridgeController } from './jobs-bridge.controller';
import { MediaSubtitlesController } from '../subtitles/media-subtitles.controller';
import { LibrariesModule } from '../libraries/libraries.module';
import { SubtitlesModule } from '../subtitles/subtitles.module';
import { SettingsModule } from '../settings/settings.module';
import { StreamingModule } from '../streaming/streaming.module';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
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
      SubtitleFile,
      Library,
    ]),
    NotificationsModule,
    AuthModule,
    LibrariesModule,
    SubtitlesModule,
    SettingsModule,
    StreamingModule,
    LogBufferModule,
    // Imported directly so the jobs bridge can reach the plugin job and catalog services.
    PluginsModule,
    ScheduledJobRegistryModule,
    LiveTvModule,
    QoeModule,
  ],
  // `MediaSubtitlesController` lives here because it needs `SubtitleSchedulerService`; it moves with S6.
  controllers: [JobsBridgeController, MediaSubtitlesController],
  providers: [SubtitleSchedulerService],
  exports: [LogBufferModule, SubtitleSchedulerService],
})
export class FliksSchedulerModule {}
