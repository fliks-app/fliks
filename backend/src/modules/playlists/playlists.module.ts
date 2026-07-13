import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Playlist } from './entities/playlist.entity';
import { PlaylistItem } from './entities/playlist-item.entity';
import { PlaylistShare } from './entities/playlist-share.entity';
import { Media } from '../media/entities/media.entity';
import { Episode } from '../media/entities/episode.entity';
import { PlaybackState } from '../streaming/entities/playback-state.entity';
import { UserFollow } from '../social/entities/user-follow.entity';
import { User } from '../users/entities/user.entity';
import { PlaylistsService } from './playlists.service';
import { PlaylistsController } from './playlists.controller';
import { AuthModule } from '../auth/auth.module';
import { LibrariesModule } from '../libraries/libraries.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Playlist,
      PlaylistItem,
      PlaylistShare,
      Media,
      Episode,
      PlaybackState,
      UserFollow,
      User,
    ]),
    forwardRef(() => AuthModule),
    LibrariesModule,
  ],
  controllers: [PlaylistsController],
  providers: [PlaylistsService],
  exports: [PlaylistsService, TypeOrmModule],
})
export class PlaylistsModule {}
