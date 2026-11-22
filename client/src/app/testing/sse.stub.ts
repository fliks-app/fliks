import { Subject, filter } from 'rxjs';
import type { PushNotification } from '../core/services/push.service';
import type { SseEvent, SseStreamType } from '../core/services/sse.service';

/** The part of `SseService` that consumers subscribe to, with `deliver` to push a frame the way the wire does. */
export function sseStub(over: Record<string, unknown> = {}) {
  const events = new Subject<SseEvent>();
  const notifications = new Subject<PushNotification>();
  return {
    events,
    notifications,
    on: (...types: SseStreamType[]) => events.pipe(filter((e) => (types as string[]).includes(e.type))),
    deliver: (event: SseEvent & { type: SseStreamType | `plugin.${string}` }) => events.next(event),
    ...over,
  };
}
