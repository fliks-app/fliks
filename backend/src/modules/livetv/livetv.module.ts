import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LiveTvSource } from './entities/livetv-source.entity';
import { LiveTvChannel } from './entities/livetv-channel.entity';
import { LiveTvChannelStream } from './entities/livetv-channel-stream.entity';
import { LiveTvGuideSource } from './entities/livetv-guide-source.entity';
import { LiveTvProgram } from './entities/livetv-program.entity';
import { LiveTvUserChannelPref } from './entities/livetv-user-channel-pref.entity';
import { LiveTvGroupAccess } from './entities/livetv-group-access.entity';
import { LiveTvGuideChannel } from './entities/livetv-guide-channel.entity';
import { LiveTvSourcesService } from './services/livetv-sources.service';
import { LiveTvChannelsService } from './services/livetv-channels.service';
import { LiveTvGuideService } from './services/livetv-guide.service';
import { LiveTvCapacityService } from './services/livetv-capacity.service';
import { LiveTvSessionService } from './services/livetv-session.service';
import { LiveTvSchedulerService } from './services/livetv-scheduler.service';
import { LiveTvAccessService } from './services/livetv-access.service';
import { LiveTvLogoService } from './services/livetv-logo.service';
import { LivetvController } from './controllers/livetv.controller';
import { LivetvAdminController } from './controllers/livetv-admin.controller';
import { LiveTvAccessController } from './controllers/livetv-access.controller';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { StreamingModule } from '../streaming/streaming.module';
import { ScheduledJobRegistryModule } from '../scheduler/scheduled-job-registry.module';
import { ImageModule } from '../images/image.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LiveTvSource,
      LiveTvChannel,
      LiveTvChannelStream,
      LiveTvGuideSource,
      LiveTvProgram,
      LiveTvUserChannelPref,
      LiveTvGroupAccess,
      LiveTvGuideChannel,
    ]),
    forwardRef(() => AuthModule),
    SettingsModule,
    StreamingModule,
    ScheduledJobRegistryModule,
    ImageModule,
    NotificationsModule,
  ],
  controllers: [LivetvController, LivetvAdminController, LiveTvAccessController],
  providers: [
    LiveTvSourcesService,
    LiveTvChannelsService,
    LiveTvGuideService,
    LiveTvCapacityService,
    LiveTvSessionService,
    LiveTvSchedulerService,
    LiveTvAccessService,
    LiveTvLogoService,
  ],
  exports: [
    LiveTvSourcesService,
    LiveTvChannelsService,
    LiveTvGuideService,
    LiveTvSessionService,
    LiveTvAccessService,
    LiveTvLogoService,
  ],
})
export class LiveTvModule {}
