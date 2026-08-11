import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Library } from '../libraries/entities/library.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../profiles/entities/language-profile.entity';
import { SubtitleProvider } from '../subtitles/entities/subtitle-provider.entity';
import { NotificationConnection } from '../notifications/entities/notification-connection.entity';
import { User } from '../users/entities/user.entity';
import { AutoApprovalRule } from '../requests/entities/auto-approval-rule.entity';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { SetupChecklistService } from './setup-checklist.service';
import { SetupChecklistController } from './setup-checklist.controller';
import { ChecklistItemRegistryModule } from './checklist-item-registry.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Library,
      QualityProfile,
      LanguageProfile,
      SubtitleProvider,
      NotificationConnection,
      User,
      AutoApprovalRule,
    ]),
    forwardRef(() => AuthModule),
    SettingsModule,
    ChecklistItemRegistryModule,
  ],
  controllers: [SetupChecklistController],
  providers: [SetupChecklistService],
})
export class SetupChecklistModule {}
