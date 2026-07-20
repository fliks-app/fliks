import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubtitleProvider } from './entities/subtitle-provider.entity';
import { SubtitleProviderStat } from './entities/subtitle-provider-stat.entity';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { SubtitleBlacklist } from './entities/subtitle-blacklist.entity';
import { TranslationProvider } from './entities/translation-provider.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MediaServersModule } from '../media-servers/media-servers.module';
import { SubtitlesService } from './subtitles.service';
import { SubtitleProviderService } from './subtitle-provider.service';
import { SubtitleSyncService } from './subtitle-sync.service';
import { SubtitleProviderFactory } from './providers/subtitle-provider.factory';
import { FfprobeService } from './ffprobe.service';
import { EmbeddedSubtitleService } from './embedded-subtitle.service';
import { SubtitleOcrService } from './subtitle-ocr.service';
import { SubtitleTranslationService } from './subtitle-translation.service';
import { SubtitleTranslationSettingsCache } from './subtitle-translation-settings-cache.service';
import { TranslationProviderService } from './translation-provider.service';
import { TranslationProviderFactory } from './providers/translation-provider.factory';
import { SubtitlesController } from './subtitles.controller';
import { TranslationProvidersController } from './translation-providers.controller';
import { SubtitleActivityController } from './subtitle-activity.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SubtitleProvider,
      SubtitleProviderStat,
      SubtitleFile,
      SubtitleBlacklist,
      TranslationProvider,
      Media,
      MediaFile,
    ]),
    AuthModule,
    SettingsModule,
    NotificationsModule,
    MediaServersModule,
  ],
  controllers: [
    SubtitlesController,
    TranslationProvidersController,
    SubtitleActivityController,
  ],
  providers: [
    SubtitlesService,
    SubtitleProviderService,
    SubtitleSyncService,
    SubtitleProviderFactory,
    FfprobeService,
    EmbeddedSubtitleService,
    SubtitleOcrService,
    SubtitleTranslationService,
    SubtitleTranslationSettingsCache,
    TranslationProviderService,
    TranslationProviderFactory,
  ],
  exports: [
    SubtitlesService,
    SubtitleProviderService,
    SubtitleSyncService,
    EmbeddedSubtitleService,
    FfprobeService,
    SubtitleOcrService,
    SubtitleTranslationService,
    TranslationProviderService,
  ],
})
export class SubtitlesModule {}
