import { EventsService } from './events.service';
import { DownloadProgressCacheService } from './download-progress-cache.service';

function connect(events: EventsService, userId: number): unknown[] {
  const received: unknown[] = [];
  events
    .getStream(userId)
    .subscribe((m) => received.push(JSON.parse((m as MessageEvent).data as string)));
  return received;
}

const progressEvent = (overrides: Partial<Record<string, unknown>> = {}) => ({
  type: 'download.progress' as const,
  mediaId: 42,
  mediaType: 'movie' as const,
  progress: 0.37,
  dlspeed: 1000,
  eta: 60,
  state: 'active' as const,
  ...overrides,
});

/**
 * The publisher (a plugin, or core itself) can tick as slowly as once a
 * minute — this is the replay that keeps a freshly connected client from
 * sitting blind until the next one. Exercised through `EventsService`, not
 * the cache directly: a passing cache write proves nothing about whether a
 * connecting client actually receives it.
 */
describe('EventsService — download.progress replay on connect', () => {
  function setup() {
    return new EventsService(new DownloadProgressCacheService());
  }

  it('replays the last push to a freshly connected recipient with no further tick', () => {
    const events = setup();
    events.emitToUsers([1], progressEvent());

    const received = connect(events, 1);

    expect(received[0]).toMatchObject({ type: 'sse.connected' });
    expect(received[1]).toMatchObject({ type: 'download.progress', mediaId: 42, progress: 0.37 });
    expect(received).toHaveLength(2);
  });

  it('never replays one user\'s progress to another — audience scoping is preserved', () => {
    const events = setup();
    events.emitToUsers([1], progressEvent());

    const receivedForOther = connect(events, 2);

    expect(receivedForOther).toHaveLength(1); // handshake only
    expect(receivedForOther.some((m) => (m as { type: string }).type === 'download.progress')).toBe(false);
  });

  it('replays independently to every recipient of a multi-user push', () => {
    const events = setup();
    events.emitToUsers([1, 2], progressEvent());

    expect(connect(events, 1)).toHaveLength(2);
    expect(connect(events, 2)).toHaveLength(2);
    expect(connect(events, 3)).toHaveLength(1);
  });

  it('retires the replay once the media reports import.complete', () => {
    const events = setup();
    events.emitToUsers([1], progressEvent());
    events.emitToUsers([1], { type: 'import.complete', mediaId: 42, title: 'x' });

    const received = connect(events, 1);

    expect(received).toHaveLength(1); // handshake only, no stale progress
  });

  it('retires only the finished season, keeping a sibling season\'s progress live', () => {
    const events = setup();
    events.emitToUsers([1], progressEvent({ seasonNumber: 1 }));
    events.emitToUsers([1], progressEvent({ seasonNumber: 2 }));
    events.emitToUsers([1], { type: 'import.complete', mediaId: 42, seasonNumber: 1, title: 'x' });

    const received = connect(events, 1);

    expect(received).toHaveLength(2); // handshake + season 2 only
    expect(received[1]).toMatchObject({ seasonNumber: 2 });
  });

  it('drops a leaf outright if a push already reports it done (progress >= 1)', () => {
    const events = setup();
    events.emitToUsers([1], progressEvent({ progress: 1 }));

    const received = connect(events, 1);

    expect(received).toHaveLength(1); // handshake only
  });

  it('a live tick after connecting still arrives normally, on top of the replay', () => {
    const events = setup();
    events.emitToUsers([1], progressEvent());

    const received = connect(events, 1);
    events.emitToUsers([1], progressEvent({ progress: 0.5 }));

    expect(received).toHaveLength(3);
    expect(received[2]).toMatchObject({ progress: 0.5 });
  });
});

/**
 * The staleness backstop: a torrent can stop existing without ever routing
 * through `import.complete` (stalled-removed, user-deleted in the client,
 * the media itself deleted…). Without an age check, that leaf's last known
 * percent would replay forever. A fake, manually-advanced clock is injected
 * so these assert on elapsed time without a real sleep or fake-timer dance.
 */
describe('DownloadProgressCacheService — staleness backstop', () => {
  function setup() {
    let t = 0;
    const cache = new DownloadProgressCacheService(() => t);
    const events = new EventsService(cache);
    return { events, cache, advance: (ms: number) => { t += ms; } };
  }

  const THRESHOLD_MS = 3 * 60_000; // mirrors STALE_AFTER_MS = 3x the 1-minute cron

  it('does not replay a leaf that stopped being refreshed past the threshold, and evicts it from the map', () => {
    const { events, cache, advance } = setup();
    events.emitToUsers([1], progressEvent());
    expect(cache.size).toBe(1);

    advance(THRESHOLD_MS + 1);
    const received = connect(events, 1);

    expect(received).toHaveLength(1); // handshake only — no phantom progress
    expect(received.some((m) => (m as { type: string }).type === 'download.progress')).toBe(false);
    expect(cache.size).toBe(0); // self-healed on the read, not merely filtered
  });

  it('still replays a leaf refreshed within the threshold', () => {
    const { events, cache, advance } = setup();
    events.emitToUsers([1], progressEvent());

    advance(THRESHOLD_MS - 1);
    const received = connect(events, 1);

    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ type: 'download.progress', mediaId: 42 });
    expect(cache.size).toBe(1); // still live, correctly not swept
  });

  it('sweeps a stale leaf even when the connecting user was never one of its recipients, with no background timer', () => {
    const { events, cache, advance } = setup();
    events.emitToUsers([1], progressEvent()); // leaf recorded for user 1 only
    advance(THRESHOLD_MS + 1);

    const receivedByOther = connect(events, 999); // unrelated user connects

    expect(receivedByOther).toHaveLength(1); // never a recipient — handshake only anyway
    expect(cache.size).toBe(0); // but the connect still swept the stale leaf
  });
});
