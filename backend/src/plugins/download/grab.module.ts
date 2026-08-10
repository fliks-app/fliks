import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Media } from '../../modules/media/entities/media.entity';
import { Season } from '../../modules/media/entities/season.entity';
import { Episode } from '../../modules/media/entities/episode.entity';
import { DownloadHistory } from './entities/download-history.entity';
import { IndexersModule } from './indexers/indexers.module';
import { DownloadClientsModule } from './download-clients/download-clients.module';
import { AuthModule } from '../../modules/auth/auth.module';
import { ProfilesModule } from '../../modules/profiles/profiles.module';
import { BlocklistModule } from '../../modules/blocklist/blocklist.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { LibrariesModule } from '../../modules/libraries/libraries.module';
import { MediaModule } from '../../modules/media/media.module';
import { GrabController } from './grab.controller';
import { MovieDownloadService } from './movie-download.service';
import { EpisodeDownloadService } from './episode-download.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Media, Season, Episode, DownloadHistory]),
    IndexersModule,
    DownloadClientsModule,
    AuthModule,
    ProfilesModule,
    BlocklistModule,
    NotificationsModule,
    LibrariesModule,
    MediaModule,
  ],
  controllers: [GrabController],
  providers: [MovieDownloadService, EpisodeDownloadService],
})
export class GrabModule {}
