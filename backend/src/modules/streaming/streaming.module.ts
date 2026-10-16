import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { LiveSessionRegistry } from './live-session.service';
import { ThumbnailService } from './thumbnail.service';
import { StreamingSettingsCache } from './streaming-settings-cache.service';
import { EngineEventsService } from './services/engine-events.service';
import { MediaFileScan } from './entities/media-file-scan.entity';
import { Command } from '../scheduler/entities/command.entity';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { LibrariesModule } from '../libraries/libraries.module';
import { MarkersModule } from '../markers/markers.module';
import { PluginsModule } from '../plugins/plugins.module';
import { PlaybackModule } from '../playback/playback.module';
import { QoeModule } from '../qoe/qoe.module';
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
    MarkersModule,
    PluginsModule,
    QoeModule,
    forwardRef(() => PlaybackModule),
  ],
  providers: [
    LiveSessionRegistry,
    ThumbnailService,
    StreamingSettingsCache,
    EngineEventsService,
  ],
  exports: [
    LiveSessionRegistry,
    ThumbnailService,
    EngineEventsService,
  ],
})
export class StreamingModule {}
