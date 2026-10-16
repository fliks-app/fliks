import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { StreamingController } from './streaming.controller';
import { StreamingService } from './streaming.service';
import { SubtitleStreamService } from './subtitle-stream.service';
import { LiveSessionRegistry } from './live-session.service';
import { SubtitleBurnInService } from './subtitle-burn-in.service';
import { ThumbnailService } from './thumbnail.service';
import { HostHardwareService } from './host-hardware.service';
import { StreamingSettingsCache } from './streaming-settings-cache.service';
import { SourceScanService } from './services/source-scan.service';
import { StaleProbeRescanService } from './services/stale-probe-rescan.service';
import { EnginePlaybackService } from './services/engine-playback.service';
import { EngineEventsService } from './services/engine-events.service';
import { ScanBackfillService } from './services/scan-backfill.service';
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
  controllers: [StreamingController],
  providers: [
    StreamingService,
    HostHardwareService,
    SubtitleStreamService,
    LiveSessionRegistry,
    SubtitleBurnInService,
    ThumbnailService,
    StreamingSettingsCache,
    SourceScanService,
    StaleProbeRescanService,
    ScanBackfillService,
    EnginePlaybackService,
    EngineEventsService,
  ],
  exports: [
    SourceScanService,
    HostHardwareService,
    StreamingService,
    LiveSessionRegistry,
    ThumbnailService,
    SubtitleStreamService,
    EngineEventsService,
  ],
})
export class StreamingModule {}
