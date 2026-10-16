import { EventsService, type DomainEvent } from './events.service';

/** An EventsService whose domain emits come straight back, standing in for the Rust hub round trip. */
export function loopbackEvents(): EventsService {
  const events = new EventsService();
  const dispatch = (events as unknown as { dispatch(b: string): void }).dispatch.bind(events);
  events.emitDomain = (event: DomainEvent) => dispatch(`data: ${JSON.stringify({ kind: 'domain', event })}`);
  return events;
}
