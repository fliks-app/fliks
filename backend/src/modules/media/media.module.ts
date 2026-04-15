import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Media } from './entities/media.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { MediaFile } from './entities/media-file.entity';
import { DownloadHistory } from './entities/download-history.entity';
import { MediaMetadata } from './entities/media-metadata.entity';
import { Person } from './entities/person.entity';
import { MediaCast } from './entities/media-cast.entity';
import { MediaCrew } from './entities/media-crew.entity';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { AuthModule } from '../auth/auth.module';
import { MetadataProvidersModule } from '../metadata-providers/metadata-providers.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { IndexersModule } from '../indexers/indexers.module';
import { DownloadClientsModule } from '../download-clients/download-clients.module';
import { BlocklistModule } from '../blocklist/blocklist.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubtitlesModule } from '../subtitles/subtitles.module';
import { MediaServersModule } from '../media-servers/media-servers.module';
import { MovieDownloadService } from './movie-download.service';
import { EpisodeDownloadService } from './episode-download.service';
import { DiskImportService } from './disk-import.service';
import { NamingService } from '../scheduler/naming.service';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { Library } from '../libraries/entities/library.entity';
import { LibrariesModule } from '../libraries/libraries.module';
import { FliksSchedulerModule } from '../scheduler/scheduler.module';
import { ImageModule } from '../images/image.module';
import { StreamingModule } from '../streaming/streaming.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Media,
      Season,
      Episode,
      MediaFile,
      DownloadHistory,
      MediaMetadata,
      Person,
      MediaCast,
      MediaCrew,
      RootFolder,
      Library,
    ]),
    AuthModule,
    MetadataProvidersModule,
    ProfilesModule,
    IndexersModule,
    DownloadClientsModule,
    BlocklistModule,
    NotificationsModule,
    SubtitlesModule,
    MediaServersModule,
    forwardRef(() => FliksSchedulerModule),
    ImageModule,
    StreamingModule,
    LibrariesModule,
  ],
  controllers: [MediaController],
  providers: [
    MediaService,
    MovieDownloadService,
    EpisodeDownloadService,
    DiskImportService,
    NamingService,
  ],
  exports: [MediaService],
})
export class MediaModule {}
