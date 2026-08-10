import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Library } from '../libraries/entities/library.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../profiles/entities/language-profile.entity';
import { DownloadClient } from '../../plugins/download/download-clients/entities/download-client.entity';
import { Indexer } from '../../plugins/download/indexers/entities/indexer.entity';
import { SubtitleProvider } from '../subtitles/entities/subtitle-provider.entity';
import { NotificationConnection } from '../notifications/entities/notification-connection.entity';
import { User } from '../users/entities/user.entity';
import { AutoApprovalRule } from '../requests/entities/auto-approval-rule.entity';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { SetupChecklistService } from './setup-checklist.service';
import { SetupChecklistController } from './setup-checklist.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Library,
      QualityProfile,
      LanguageProfile,
      DownloadClient,
      Indexer,
      SubtitleProvider,
      NotificationConnection,
      User,
      AutoApprovalRule,
    ]),
    forwardRef(() => AuthModule),
    SettingsModule,
  ],
  controllers: [SetupChecklistController],
  providers: [SetupChecklistService],
})
export class SetupChecklistModule {}
