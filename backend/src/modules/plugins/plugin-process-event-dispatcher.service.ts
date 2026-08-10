import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { EventsService, type DomainEvent } from '../scheduler/events.service';
import { PluginProcessService } from './plugin-process.service';

/** Fans a domain event out to every ready `process` plugin over its socket, mirroring
 *  `PluginWebhookDispatcherService`'s at-most-once contract — no filtering, no retry. */
@Injectable()
export class PluginProcessEventDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly subscription = new Subscription();

  constructor(
    private readonly events: EventsService,
    private readonly processes: PluginProcessService,
  ) {}

  onModuleInit(): void {
    this.subscription.add(this.events.onDomain((event: DomainEvent) => this.processes.emitToAll(event.type, event)));
  }

  onModuleDestroy(): void {
    this.subscription.unsubscribe();
  }
}
