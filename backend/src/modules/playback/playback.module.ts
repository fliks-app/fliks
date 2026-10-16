import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlaybackState } from './entities/playback-state.entity';
import { RecommendationDismissal } from './entities/recommendation-dismissal.entity';
import { PlaybackService } from './playback.service';

@Module({
  imports: [TypeOrmModule.forFeature([PlaybackState, RecommendationDismissal])],
  providers: [PlaybackService],
  exports: [PlaybackService],
})
export class PlaybackModule {}
