import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserFollow } from './entities/user-follow.entity';
import { User } from '../users/entities/user.entity';
import { PlaybackState } from '../playback/entities/playback-state.entity';
import { Media } from '../media/entities/media.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { Like } from './entities/like.entity';
import { ContentRecommendation } from './entities/content-recommendation.entity';
import { SocialService } from './social.service';
import { SocialController } from './social.controller';
import { LikesService } from './likes.service';
import { LikesController } from './likes.controller';
import { PlaylistsModule } from '../playlists/playlists.module';
import { StreamingModule } from '../streaming/streaming.module';
import { PlaybackModule } from '../playback/playback.module';
import { LibrariesModule } from '../libraries/libraries.module';
import { EventsModule } from '../scheduler/events.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserFollow,
      User,
      PlaybackState,
      Media,
      Season,
      Episode,
      Like,
      ContentRecommendation,
    ]),
    PlaylistsModule,
    StreamingModule,
    PlaybackModule,
    LibrariesModule,
    EventsModule,
    AuthModule,
    UsersModule,
  ],
  controllers: [SocialController, LikesController],
  providers: [SocialService, LikesService],
  exports: [LikesService, SocialService],
})
export class SocialModule {}
