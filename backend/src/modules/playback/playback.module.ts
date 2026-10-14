import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlaybackState } from './entities/playback-state.entity';
import { RecommendationDismissal } from './entities/recommendation-dismissal.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';
import { RecommendationService } from './recommendation.service';
import { AuthModule } from '../auth/auth.module';
import { LibrariesModule } from '../libraries/libraries.module';
import { PlaylistsModule } from '../playlists/playlists.module';
import { QoeModule } from '../qoe/qoe.module';
import { StreamingModule } from '../streaming/streaming.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PlaybackState, RecommendationDismissal, Media, MediaFile, Episode]),
    AuthModule,
    LibrariesModule,
    PlaylistsModule,
    QoeModule,
    forwardRef(() => StreamingModule),
  ],
  controllers: [PlaybackController],
  providers: [PlaybackService, RecommendationService],
  exports: [PlaybackService, RecommendationService],
})
export class PlaybackModule {}
