import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Media } from '../../modules/media/entities/media.entity';
import { MediaFile } from '../../modules/media/entities/media-file.entity';
import { Episode } from '../../modules/media/entities/episode.entity';
import { LibraryIngestService } from './library-ingest.service';
import { FliksSchedulerModule } from '../../modules/scheduler/scheduler.module';
import { MediaModule } from '../../modules/media/media.module';
import { SubtitlesModule } from '../../modules/subtitles/subtitles.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Media, MediaFile, Episode]),
    forwardRef(() => FliksSchedulerModule),
    forwardRef(() => MediaModule),
    SubtitlesModule,
  ],
  providers: [LibraryIngestService],
  exports: [LibraryIngestService],
})
export class LibraryIngestModule {}
