import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlaybackState } from './entities/playback-state.entity';
import { RecommendationDismissal } from './entities/recommendation-dismissal.entity';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';
import { AuthModule } from '../auth/auth.module';
import { PlaylistsModule } from '../playlists/playlists.module';
import { QoeModule } from '../qoe/qoe.module';
import { StreamingModule } from '../streaming/streaming.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PlaybackState, RecommendationDismissal]),
    AuthModule,
    PlaylistsModule,
    QoeModule,
    forwardRef(() => StreamingModule),
  ],
  controllers: [PlaybackController],
  providers: [PlaybackService],
  exports: [PlaybackService],
})
export class PlaybackModule {}
