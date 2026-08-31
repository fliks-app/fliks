import { EventsService } from './events.service';
import { DownloadProgressCacheService } from './download-progress-cache.service';
import type { SseEvent } from './events.service';

const open: (() => void)[] = [];

afterEach(() => {
  while (open.length) open.pop()!();
});

/** Subscribe as one device and collect what it actually receives. */
function connect(
  events: EventsService,
  userId: number,
  identity?: { targetId?: string; formFactor?: string; tvPlatform?: string; deviceName?: string },
) {
  const received: SseEvent[] = [];
  const sub = events
    .getStream(userId, {
      targetId: identity?.targetId ?? null,
      formFactor: identity?.formFactor ?? null,
      tvPlatform: identity?.tvPlatform ?? null,
      deviceName: identity?.deviceName ?? null,
      userAgent: null,
    })
    .subscribe((m) => {
      const raw = (m as MessageEvent).data as string;
      if (raw) received.push(JSON.parse(raw) as SseEvent);
    });
  const close = () => sub.unsubscribe();
  open.push(close);
  return { received, close };
}

const command = (cmdId: string): SseEvent => ({
  type: 'remote.command',
  cmdId,
  expiresAt: Date.now() + 10_000,
  byTargetId: null,
  action: 'pause',
});

/**
 * The registry is what makes a device addressable while it plays nothing, and
 * its scoping is the authorization: a target id must name nothing outside its
 * owner's own connections. Exercised through the service rather than the Map so
 * a passing test proves a real client is reachable, not just that a key exists.
 */
describe('EventsService: remote target registry', () => {
  const setup = () => new EventsService(new DownloadProgressCacheService());

  it('lists only the announcing connections of the asking user', () => {
    const events = setup();
    connect(events, 1, { targetId: 'dev-a#t1', formFactor: 'tv' });
    connect(events, 1, { targetId: 'dev-b#t1', formFactor: 'phone' });
    connect(events, 2, { targetId: 'dev-c#t1' });
    // No announce: an older build never becomes a target.
    connect(events, 1);

    const mine = events.listForUser(1);
    expect(mine.map((r) => r.targetId).sort()).toEqual(['dev-a#t1', 'dev-b#t1']);
    expect(events.listForUser(2).map((r) => r.targetId)).toEqual(['dev-c#t1']);
    expect(mine.find((r) => r.targetId === 'dev-a#t1')?.formFactor).toBe('tv');
  });

  it('gives a launch claim to the matching playback, once', () => {
    const events = setup();
    events.claimAttribution('tv#t1', 7, 42);

    // The file is part of the match: a target that starts something else in the
    // meantime must not inherit the launcher.
    expect(events.takeAttribution('tv#t1', 42)).toBe(7);
    // Consumed: the next playback on that target is the device's own again.
    expect(events.takeAttribution('tv#t1', 42)).toBeNull();

    events.claimAttribution('tv#t1', 7, 42);
    expect(events.takeAttribution('tv#t1', 99)).toBeNull();
    expect(events.takeAttribution(null, 42)).toBeNull();
  });

  it('refuses to resolve another user\'s target', () => {
    const events = setup();
    connect(events, 1, { targetId: 'mine#t1' });
    connect(events, 2, { targetId: 'theirs#t1' });

    expect(events.resolveTarget(1, 'mine#t1')).not.toBeNull();
    expect(events.resolveTarget(1, 'theirs#t1')).toBeNull();
    expect(events.resolveTarget(2, 'mine#t1')).toBeNull();
  });

  it('delivers a command to one connection and to no sibling', () => {
    const events = setup();
    const tv = connect(events, 1, { targetId: 'tv#t1' });
    const phone = connect(events, 1, { targetId: 'phone#t1' });

    const connectionId = events.resolveTarget(1, 'tv#t1');
    expect(connectionId).not.toBeNull();
    expect(events.emitToConnection(connectionId!, command('c1'))).toBe(true);

    expect(tv.received.filter((e) => e.type === 'remote.command')).toHaveLength(1);
    expect(phone.received.filter((e) => e.type === 'remote.command')).toHaveLength(0);
  });

  it('reports a dead socket instead of swallowing the command', () => {
    const events = setup();
    const tv = connect(events, 1, { targetId: 'tv#t1' });
    const connectionId = events.resolveTarget(1, 'tv#t1')!;
    tv.close();

    expect(events.emitToConnection(connectionId, command('c2'))).toBe(false);
    expect(events.resolveTarget(1, 'tv#t1')).toBeNull();
  });

  it('announces the list changing on connect and on teardown', () => {
    const events = setup();
    const watcher = connect(events, 1, { targetId: 'watcher#t1' });
    const changesBefore = watcher.received.filter(
      (e) => e.type === 'remote.targets_changed',
    ).length;

    const other = connect(events, 1, { targetId: 'other#t1' });
    expect(
      watcher.received.filter((e) => e.type === 'remote.targets_changed').length,
    ).toBe(changesBefore + 1);

    other.close();
    expect(
      watcher.received.filter((e) => e.type === 'remote.targets_changed').length,
    ).toBe(changesBefore + 2);
  });

  it('evicts a superseded connection so a relaunched device is listed once', () => {
    const events = setup();
    // A killed webview sends no FIN, so its entry outlives it; the relaunch
    // reuses the same target id and is what reveals the corpse.
    connect(events, 1, { targetId: 'phone-device' });
    connect(events, 1, { targetId: 'phone-device' });

    const rows = events.listForUser(1).filter((r) => r.targetId === 'phone-device');
    expect(rows).toHaveLength(1);
  });

  it('keeps two browser tabs of one device as separate targets', () => {
    const events = setup();
    connect(events, 1, { targetId: 'browser-device#tab1' });
    connect(events, 1, { targetId: 'browser-device#tab2' });

    expect(events.listForUser(1)).toHaveLength(2);
  });

  it('drops every connection of a revoked user', () => {
    const events = setup();
    connect(events, 1, { targetId: 'a#t1' });
    connect(events, 1, { targetId: 'b#t1' });
    connect(events, 2, { targetId: 'c#t1' });

    events.dropConnectionsForUser(1);

    expect(events.listForUser(1)).toHaveLength(0);
    expect(events.listForUser(2)).toHaveLength(1);
  });

  it('actually closes the stream on a revocation, not just the registry entry', () => {
    // A dropped `ConnectionIdentity` with a live SSE response behind it would
    // leave that response open forever: the client never learns to reconnect.
    const events = setup();
    let completed = false;
    const sub = events
      .getStream(1, { targetId: 'tv#t1', formFactor: null, tvPlatform: null, deviceName: null, userAgent: null })
      .subscribe({ complete: () => { completed = true; } });
    open.push(() => sub.unsubscribe());

    events.dropConnectionsForUser(1);

    expect(completed).toBe(true);
    expect(sub.closed).toBe(true);
  });

  it('scopes a logout drop to the named device, leaving sibling devices live', () => {
    const events = setup();
    const phone = connect(events, 1, { targetId: 'phone#t1' });
    const tv = connect(events, 1, { targetId: 'tv#t1' });

    events.dropConnectionsForTarget(1, 'phone#t1');

    expect(events.listForUser(1).map((r) => r.targetId)).toEqual(['tv#t1']);
    expect(phone.received.some((e) => e.type === 'sse.connected')).toBe(true);
  });

  it('resolves a polled target through targetIdFor the same as a live SSE one', () => {
    const events = setup();
    events.registerPolledTarget(1, {
      targetId: 'appletv#t1',
      formFactor: 'tv',
      tvPlatform: 'tvos',
      deviceName: null,
      userAgent: null,
    });

    expect(events.targetIdFor('polled:appletv#t1')).toBe('appletv#t1');
    expect(events.targetIdFor('nonexistent')).toBeNull();
  });
});
