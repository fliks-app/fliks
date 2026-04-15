import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaServer } from '../users/entities/media-server.entity';
import { User } from '../users/entities/user.entity';
import { Media } from '../media/entities/media.entity';
import { Episode } from '../media/entities/episode.entity';
import { PlaybackState } from '../streaming/entities/playback-state.entity';
import { MediaServersService } from './media-servers.service';
import { MediaServersController } from './media-servers.controller';
import { EmbyProvider } from './providers/emby.provider';
import { EmbyWatchHistoryImportService } from './emby-watch-history-import.service';
import { AuthModule } from '../auth/auth.module';
import { RolesModule } from '../roles/roles.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MediaServer,
      User,
      Media,
      Episode,
      PlaybackState,
    ]),
    AuthModule,
    RolesModule,
  ],
  controllers: [MediaServersController],
  providers: [MediaServersService, EmbyProvider, EmbyWatchHistoryImportService],
  exports: [MediaServersService],
})
export class MediaServersModule {}
