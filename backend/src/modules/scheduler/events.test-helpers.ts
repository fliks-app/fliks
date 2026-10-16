import { EventsService, type DomainEvent } from './events.service';

/** An EventsService whose domain emits come straight back, standing in for the Rust hub round trip. */
export function loopbackEvents(): EventsService {
  const events = new EventsService();
  // Bracket access keeps the private dispatch type-checked, so a signature change breaks here.
  events.emitDomain = (event: DomainEvent) => events['dispatch'](`data: ${JSON.stringify({ kind: 'domain', event })}`);
  return events;
}
