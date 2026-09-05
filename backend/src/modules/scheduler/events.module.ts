import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsService } from './events.service';
import { SseAudienceService } from './sse-audience.service';
import { DownloadProgressCacheService } from './download-progress-cache.service';
import { ActivityRegistryService } from './activity-registry.service';
import { FliksRequest } from '../requests/entities/request.entity';
import { User } from '../users/entities/user.entity';
import { Media } from '../media/entities/media.entity';
import { LibraryUserAccess } from '../libraries/entities/library-user-access.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([FliksRequest, User, Media, LibraryUserAccess])],
  providers: [
    EventsService,
    SseAudienceService,
    DownloadProgressCacheService,
    ActivityRegistryService,
  ],
  exports: [
    EventsService,
    SseAudienceService,
    DownloadProgressCacheService,
    ActivityRegistryService,
  ],
})
export class EventsModule {}
