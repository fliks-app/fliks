import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Media } from './entities/media.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { MediaFile } from './entities/media-file.entity';
import { DownloadHistory } from './entities/download-history.entity';
import { Tag } from '../tags/entities/tag.entity';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { AuthModule } from '../auth/auth.module';
import { MetadataProvidersModule } from '../metadata-providers/metadata-providers.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { IndexersModule } from '../indexers/indexers.module';
import { DownloadClientsModule } from '../download-clients/download-clients.module';
import { BlocklistModule } from '../blocklist/blocklist.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MovieDownloadService } from './movie-download.service';
import { EpisodeDownloadService } from './episode-download.service';
import { DiskImportService } from './disk-import.service';
import { RootFolder } from '../root-folders/entities/root-folder.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Media,
      Season,
      Episode,
      MediaFile,
      DownloadHistory,
      Tag,
      RootFolder,
    ]),
    AuthModule,
    MetadataProvidersModule,
    ProfilesModule,
    IndexersModule,
    DownloadClientsModule,
    BlocklistModule,
    NotificationsModule,
  ],
  controllers: [MediaController],
  providers: [MediaService, MovieDownloadService, EpisodeDownloadService, DiskImportService],
  exports: [MediaService],
})
export class MediaModule {}
