import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsService } from './events.service';
import { SseAudienceService } from './sse-audience.service';
import { FliksRequest } from '../requests/entities/request.entity';
import { User } from '../users/entities/user.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([FliksRequest, User])],
  providers: [EventsService, SseAudienceService],
  exports: [EventsService, SseAudienceService],
})
export class EventsModule {}
