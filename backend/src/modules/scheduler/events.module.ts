import { Global, Module } from '@nestjs/common';
import { EventsService } from './events.service';

@Global()
@Module({
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
