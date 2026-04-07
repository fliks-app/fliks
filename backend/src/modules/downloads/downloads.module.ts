import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DownloadTask } from './entities/download-task.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { StreamingModule } from '../streaming/streaming.module';
import { AuthModule } from '../auth/auth.module';
import { DownloadsService } from './downloads.service';
import { DownloadsController } from './downloads.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([DownloadTask, MediaFile, Episode, SubtitleFile]),
    StreamingModule,
    AuthModule,
  ],
  controllers: [DownloadsController],
  providers: [DownloadsService],
  exports: [DownloadsService],
})
export class DownloadsModule {}
