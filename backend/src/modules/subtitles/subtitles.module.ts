import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubtitleProvider } from './entities/subtitle-provider.entity';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Tag } from '../tags/entities/tag.entity';
import { AuthModule } from '../auth/auth.module';
import { SubtitlesService } from './subtitles.service';
import { SubtitleProviderService } from './subtitle-provider.service';
import { SubtitleSyncService } from './subtitle-sync.service';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';
import { SubtitlesController } from './subtitles.controller';
import { SubtitleActivityController } from './subtitle-activity.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([SubtitleProvider, SubtitleFile, Tag]),
    AuthModule,
  ],
  controllers: [SubtitlesController, SubtitleActivityController],
  providers: [
    SubtitlesService,
    SubtitleProviderService,
    SubtitleSyncService,
    SubtitleProviderFactory,
  ],
  exports: [SubtitlesService, SubtitleProviderService, SubtitleSyncService],
})
export class SubtitlesModule {}
