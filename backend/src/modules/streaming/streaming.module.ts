import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { LiveSessionRegistry } from './live-session.service';
import { ThumbnailService } from './thumbnail.service';
import { EngineEventsService } from './services/engine-events.service';
import { MediaFileScan } from './entities/media-file-scan.entity';
import { Command } from '../scheduler/entities/command.entity';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { LibrariesModule } from '../libraries/libraries.module';
import { PlaybackModule } from '../playback/playback.module';
import { MediaProbeModule } from '../media-probe/media-probe.module';

@Module({
  imports: [
    MediaProbeModule,
    TypeOrmModule.forFeature([
      Media,
      MediaFile,
      MediaFileScan,
      SubtitleFile,
      Command,
    ]),
    AuthModule,
    SettingsModule,
    LibrariesModule,
    forwardRef(() => PlaybackModule),
  ],
  providers: [
    LiveSessionRegistry,
    ThumbnailService,
    EngineEventsService,
  ],
  exports: [
    LiveSessionRegistry,
    ThumbnailService,
    EngineEventsService,
  ],
})
export class StreamingModule {}
