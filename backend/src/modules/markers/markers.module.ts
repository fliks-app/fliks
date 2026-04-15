import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EpisodeMarker } from './entities/episode-marker.entity';
import { Episode } from '../media/entities/episode.entity';
import { Season } from '../media/entities/season.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Command } from '../scheduler/entities/command.entity';
import { MarkersService } from './markers.service';
import { IntroDetectionService } from './intro-detection.service';
import { MarkersController } from './markers.controller';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EpisodeMarker,
      Episode,
      Season,
      Media,
      MediaFile,
      Command,
    ]),
    AuthModule,
    SettingsModule,
  ],
  controllers: [MarkersController],
  providers: [MarkersService, IntroDetectionService],
  exports: [MarkersService],
})
export class MarkersModule {}
