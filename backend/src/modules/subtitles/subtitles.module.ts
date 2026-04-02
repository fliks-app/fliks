import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubtitleProvider } from './entities/subtitle-provider.entity';
import { SubtitleProviderStat } from './entities/subtitle-provider-stat.entity';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Tag } from '../tags/entities/tag.entity';
import { AuthModule } from '../auth/auth.module';
import { SubtitlesService } from './subtitles.service';
import { SubtitleProviderService } from './subtitle-provider.service';
import { SubtitleSyncService } from './subtitle-sync.service';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';
import { FfprobeService } from './ffprobe.service';
import { EmbeddedSubtitleService } from './embedded-subtitle.service';
import { SubtitlesController } from './subtitles.controller';
import { SubtitleActivityController } from './subtitle-activity.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SubtitleProvider,
      SubtitleProviderStat,
      SubtitleFile,
      Media,
      MediaFile,
      Tag,
    ]),
    AuthModule,
  ],
  controllers: [SubtitlesController, SubtitleActivityController],
  providers: [
    SubtitlesService,
    SubtitleProviderService,
    SubtitleSyncService,
    SubtitleProviderFactory,
    FfprobeService,
    EmbeddedSubtitleService,
  ],
  exports: [
    SubtitlesService,
    SubtitleProviderService,
    SubtitleSyncService,
    EmbeddedSubtitleService,
  ],
})
export class SubtitlesModule {}
