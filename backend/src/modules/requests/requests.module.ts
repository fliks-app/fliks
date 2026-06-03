import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FliksRequest } from './entities/request.entity';
import { RequestComment } from './entities/request-comment.entity';
import { AutoApprovalRule } from './entities/auto-approval-rule.entity';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { MediaModule } from '../media/media.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { FliksSchedulerModule } from '../scheduler/scheduler.module';
import { ImageModule } from '../images/image.module';
import { MetadataProvidersModule } from '../metadata-providers/metadata-providers.module';
import { RequestsService } from './requests.service';
import { RequestLifecycleService } from './request-lifecycle.service';
import { RequestsController } from './requests.controller';
import { AutoApprovalRulesController } from './auto-approval-rules.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([FliksRequest, RequestComment, AutoApprovalRule]),
    AuthModule,
    NotificationsModule,
    SettingsModule,
    // forwardRef: MediaModule injects RequestLifecycleService for the
    // import / remove / unmonitor hooks, and we inject MediaService here
    // for the monitoring + 409 fallback lookups.
    forwardRef(() => MediaModule),
    ProfilesModule,
    // forwardRef because FliksSchedulerModule itself imports MediaModule,
    // which already imports RequestsModule via forwardRef — defensive to
    // avoid the cycle resolver throwing on a clean cold boot.
    forwardRef(() => FliksSchedulerModule),
    // Local request-card art stored at creation (ImageService) from the
    // provider's TMDB URLs (TmdbProvider).
    ImageModule,
    MetadataProvidersModule,
  ],
  controllers: [RequestsController, AutoApprovalRulesController],
  providers: [RequestsService, RequestLifecycleService],
  exports: [RequestsService, RequestLifecycleService],
})
export class RequestsModule {}
