import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlaybackState } from './entities/playback-state.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { Season } from '../media/entities/season.entity';
import { StreamingController } from './streaming.controller';
import { PlaybackController } from './playback.controller';
import { StreamingService } from './streaming.service';
import { SubtitleStreamService } from './subtitle-stream.service';
import { TranscodingService } from './transcoding.service';
import { StreamBuilderService } from './stream-builder.service';
import { PlaybackService } from './playback.service';
import { ActiveStreamTracker } from './active-stream-tracker.service';
import { SubtitleBurnInService } from './subtitle-burn-in.service';
import { ThumbnailService } from './thumbnail.service';
import { Command } from '../scheduler/entities/command.entity';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlaybackState,
      Media,
      MediaFile,
      SubtitleFile,
      Episode,
      Season,
      Command,
    ]),
    AuthModule,
    SettingsModule,
  ],
  controllers: [StreamingController, PlaybackController],
  providers: [
    StreamingService,
    SubtitleStreamService,
    TranscodingService,
    StreamBuilderService,
    PlaybackService,
    ActiveStreamTracker,
    SubtitleBurnInService,
    ThumbnailService,
  ],
  exports: [
    PlaybackService,
    TranscodingService,
    StreamingService,
    ActiveStreamTracker,
    ThumbnailService,
  ],
})
export class StreamingModule {}
