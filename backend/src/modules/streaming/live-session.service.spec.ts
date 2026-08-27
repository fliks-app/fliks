import { LiveSessionRegistry } from './live-session.service';

const BASE = {
  userId: 1,
  username: 'alice',
  mediaFileId: 42,
  profileHash: 'aaaaaaaaaa',
  quality: '1080p',
  kind: 'transcode' as const,
};

describe('LiveSessionRegistry', () => {
  let svc: LiveSessionRegistry;

  beforeEach(() => {
    svc = new LiveSessionRegistry();
    svc.onModuleInit();
  });

  afterEach(() => {
    svc.onModuleDestroy();
  });

  it('issues a unique sessionId on create', () => {
    const a = svc.create(BASE);
    const b = svc.create(BASE);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(svc.size()).toBe(2);
  });

  it('returns null when heartbeating an unknown sessionId', () => {
    expect(svc.heartbeat('missing', { position: 10 })).toBeNull();
  });

  it('refreshes lastBeat and merges payload on heartbeat', async () => {
    const session = svc.create(BASE);
    const initialBeat = session.lastBeat;
    await new Promise((r) => setTimeout(r, 5));
    const updated = svc.heartbeat(session.sessionId, {
      position: 123,
      state: 'paused',
      audioTrackIndex: 2,
    });
    expect(updated).not.toBeNull();
    expect(updated!.lastBeat).toBeGreaterThan(initialBeat);
    expect(updated!.position).toBe(123);
    expect(updated!.state).toBe('paused');
    expect(updated!.audioTrackIndex).toBe(2);
    // Unspecified fields stay put.
    expect(updated!.subtitleTrackIndex).toBeNull();
    expect(updated!.quality).toBe('1080p');
  });

  it('touch refreshes lastBeat without mutating playback fields', async () => {
    const session = svc.create({ ...BASE, position: 7 });
    const initialBeat = session.lastBeat;
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.touch(session.sessionId)).toBe(true);
    expect(session.lastBeat).toBeGreaterThan(initialBeat);
    // A fetch is liveness only — it must not touch the playhead.
    expect(session.position).toBe(7);
  });

  it('touch returns false for an unknown sessionId', () => {
    expect(svc.touch('missing')).toBe(false);
  });

  it('stop removes the session and returns true', () => {
    const session = svc.create(BASE);
    expect(svc.stop(session.sessionId)).toBe(true);
    expect(svc.stop(session.sessionId)).toBe(false);
    expect(svc.size()).toBe(0);
  });

  it('listForJob filters by (user, file, profile); a concurrent dup is split off', () => {
    svc.create({ ...BASE, profileHash: 'aaa' });
    const dup = svc.create({ ...BASE, profileHash: 'aaa' });
    svc.create({ ...BASE, profileHash: 'bbb' });
    svc.create({ ...BASE, mediaFileId: 99, profileHash: 'aaa' });
    expect(dup.instanceId).not.toBeNull();
    expect(dup.profileHash).toBe('aaa' + dup.instanceId);
    expect(svc.listForJob(1, 42, 'aaa')).toHaveLength(1);
    expect(svc.listForJob(1, 42, dup.profileHash!)).toHaveLength(1);
    expect(svc.listForJob(1, 42, 'bbb')).toHaveLength(1);
    expect(svc.listForJob(1, 99, 'aaa')).toHaveLength(1);
    expect(svc.listForJob(1, 99, 'bbb')).toHaveLength(0);
  });

  it('does not split a same-connection reload (shared sseConnectionId)', () => {
    svc.create({ ...BASE, profileHash: 'aaa', sseConnectionId: 'c1' });
    const reload = svc.create({ ...BASE, profileHash: 'aaa', sseConnectionId: 'c1' });
    expect(reload.instanceId).toBeNull();
    expect(reload.profileHash).toBe('aaa');
  });

  it('list returns Date-typed snapshots', () => {
    const session = svc.create(BASE);
    const snapshots = svc.list();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].sessionId).toBe(session.sessionId);
    expect(snapshots[0].startedAt).toBeInstanceOf(Date);
    expect(snapshots[0].lastBeat).toBeInstanceOf(Date);
  });

  it('create stores per-session settings inline', () => {
    const session = svc.create({
      ...BASE,
      useTs: true,
      audioPlan: { mode: 'copy', codec: 'eac3' },
      deviceType: 'mobile',
      hdrLadder: true,
      audioStreamCount: 3,
    });
    expect(session.useTs).toBe(true);
    expect(session.audioPlan).toEqual({ mode: 'copy', codec: 'eac3' });
    expect(session.deviceType).toBe('mobile');
    expect(session.hdrLadder).toBe(true);
    expect(session.audioStreamCount).toBe(3);
    // Defaults apply for fields not supplied.
    expect(session.useExtXMedia).toBe(false);
    expect(session.canCopyVideo).toBe(false);
    expect(session.canCopyAudio).toBe(false);
    expect(session.transcodeReasons).toEqual([]);
  });

  it('update mutates supplied fields and leaves the rest alone', () => {
    const session = svc.create({
      ...BASE,
      useTs: true,
      audioStreamCount: 0,
    });
    const updated = svc.update(session.sessionId, {
      audioStreamCount: 2,
      useExtXMedia: true,
    });
    expect(updated).not.toBeNull();
    expect(updated!.audioStreamCount).toBe(2);
    expect(updated!.useExtXMedia).toBe(true);
    expect(updated!.useTs).toBe(true);
  });

  it('update on an unknown sid returns null', () => {
    expect(svc.update('missing', { useTs: true })).toBeNull();
  });

  it('findCurrent returns the most-recently-active session for (user, file)', async () => {
    const older = svc.create(BASE);
    await new Promise((r) => setTimeout(r, 5));
    const newer = svc.create(BASE);
    // Heartbeat older to reorder — newer was inserted last but older
    // just sent a beat.
    await new Promise((r) => setTimeout(r, 5));
    svc.heartbeat(older.sessionId, { position: 1 });
    const current = svc.findCurrent(BASE.userId, BASE.mediaFileId);
    expect(current?.sessionId).toBe(older.sessionId);
    // Brand new heartbeat on newer makes it win again.
    await new Promise((r) => setTimeout(r, 5));
    svc.heartbeat(newer.sessionId, { position: 1 });
    expect(svc.findCurrent(BASE.userId, BASE.mediaFileId)?.sessionId).toBe(
      newer.sessionId,
    );
  });

  it('findCurrent isolates by (user, file) — does not bleed across users', () => {
    const aliceSession = svc.create(BASE);
    svc.create({ ...BASE, userId: 99, username: 'bob' });
    expect(svc.findCurrent(BASE.userId, BASE.mediaFileId)?.sessionId).toBe(
      aliceSession.sessionId,
    );
    expect(svc.findCurrent(99, BASE.mediaFileId)?.userId).toBe(99);
    // Different file → no match.
    expect(svc.findCurrent(BASE.userId, 999)).toBeNull();
  });

  it('same user on two devices for the same file keeps both states isolated', () => {
    // Alice opens her browser (fMP4, desktop ladder) AND her Tizen TV
    // (TS container, no HDR ladder) on the same file. Each session
    // carries its own settings — there is no shared per-(user, file)
    // state that the second playback-info could clobber.
    const browser = svc.create({
      ...BASE,
      profileHash: 'browser-hash',
      useTs: false,
      deviceType: 'desktop',
      hdrLadder: true,
    });
    const tv = svc.create({
      ...BASE,
      profileHash: 'tizen-hash',
      useTs: true,
      deviceType: 'desktop',
      hdrLadder: false,
    });
    expect(browser.useTs).toBe(false);
    expect(browser.hdrLadder).toBe(true);
    expect(tv.useTs).toBe(true);
    expect(tv.hdrLadder).toBe(false);
    // listForJob also keeps them apart via profileHash.
    expect(svc.listForJob(BASE.userId, BASE.mediaFileId, 'browser-hash'))
      .toHaveLength(1);
    expect(svc.listForJob(BASE.userId, BASE.mediaFileId, 'tizen-hash'))
      .toHaveLength(1);
  });
});

describe('LiveSessionRegistry GC', () => {
  const ENV = process.env;
  let svc: LiveSessionRegistry;

  beforeEach(() => {
    process.env = { ...ENV };
  });

  afterEach(() => {
    svc?.onModuleDestroy();
    process.env = ENV;
  });

  it('drops sessions past the configured ttl on gc tick', async () => {
    process.env.STREAM_LIVE_SESSION_TTL_MS = '50';
    process.env.STREAM_LIVE_SESSION_GC_INTERVAL_MS = '20';
    svc = new LiveSessionRegistry();
    svc.onModuleInit();
    svc.create(BASE);
    expect(svc.size()).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(svc.size()).toBe(0);
  });

  it('keeps sessions kept alive by heartbeats', async () => {
    process.env.STREAM_LIVE_SESSION_TTL_MS = '80';
    process.env.STREAM_LIVE_SESSION_GC_INTERVAL_MS = '30';
    svc = new LiveSessionRegistry();
    svc.onModuleInit();
    const session = svc.create(BASE);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 30));
      svc.heartbeat(session.sessionId, { position: i });
    }
    expect(svc.size()).toBe(1);
  });

  it('revives a GC\'d session on the sid it already holds', async () => {
    // Laptop sleep: heartbeats stop, GC drops the session, then the client
    // comes back with the same sid. It must resume, not 410.
    process.env.STREAM_LIVE_SESSION_TTL_MS = '50';
    process.env.STREAM_LIVE_SESSION_GC_INTERVAL_MS = '20';
    svc = new LiveSessionRegistry();
    svc.onModuleInit();
    const session = svc.create({ ...BASE, position: 640 });
    await new Promise((r) => setTimeout(r, 100));
    expect(svc.size()).toBe(0);
    expect(svc.touch(session.sessionId)).toBe(true);
    expect(svc.size()).toBe(1);
    // Revived with its context intact — that is what lets the segment route
    // respawn ffmpeg instead of demanding a fresh playback-info.
    expect(svc.get(session.sessionId)!.position).toBe(640);
    expect(svc.get(session.sessionId)!.profileHash).toBe('aaaaaaaaaa');
    // And the heartbeat no longer reports the session as lost.
    expect(svc.heartbeat(session.sessionId, { position: 650 })).not.toBeNull();
  });

  it('does not revive past the revive window', async () => {
    process.env.STREAM_LIVE_SESSION_TTL_MS = '20';
    process.env.STREAM_LIVE_SESSION_GC_INTERVAL_MS = '10';
    process.env.STREAM_SESSION_REVIVE_TTL_MS = '60';
    svc = new LiveSessionRegistry();
    svc.onModuleInit();
    const session = svc.create(BASE);
    await new Promise((r) => setTimeout(r, 150));
    expect(svc.touch(session.sessionId)).toBe(false);
    expect(svc.heartbeat(session.sessionId, {})).toBeNull();
  });

  it('an explicit stop is not revivable', async () => {
    process.env.STREAM_LIVE_SESSION_TTL_MS = '50';
    process.env.STREAM_LIVE_SESSION_GC_INTERVAL_MS = '20';
    svc = new LiveSessionRegistry();
    svc.onModuleInit();
    const session = svc.create(BASE);
    expect(svc.stop(session.sessionId)).toBe(true);
    expect(svc.touch(session.sessionId)).toBe(false);
  });

  it('keeps sessions kept alive by segment-fetch touches alone', async () => {
    // No client heartbeat at all — the receiver pulling segments must be
    // enough to survive the ttl (the Cast crash repro).
    process.env.STREAM_LIVE_SESSION_TTL_MS = '80';
    process.env.STREAM_LIVE_SESSION_GC_INTERVAL_MS = '30';
    svc = new LiveSessionRegistry();
    svc.onModuleInit();
    const session = svc.create(BASE);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 30));
      expect(svc.touch(session.sessionId)).toBe(true);
    }
    expect(svc.size()).toBe(1);
  });
});

describe('LiveSessionRegistry per-user cap', () => {
  const ENV = process.env;
  let svc: LiveSessionRegistry;

  beforeEach(() => {
    process.env = { ...ENV };
  });

  afterEach(() => {
    svc?.onModuleDestroy();
    process.env = ENV;
  });

  it('evicts the oldest-lastBeat session once a user is over the cap', async () => {
    process.env.STREAM_MAX_SESSIONS_PER_USER = '2';
    svc = new LiveSessionRegistry();
    svc.onModuleInit();

    const first = svc.create(BASE);
    await new Promise((r) => setTimeout(r, 5));
    const second = svc.create(BASE);
    // The user is at the cap (2). The third create evicts the
    // oldest-beaten entry (first) rather than rejecting the new one.
    await new Promise((r) => setTimeout(r, 5));
    const third = svc.create(BASE);

    expect(svc.get(first.sessionId)).toBeNull();
    expect(svc.get(second.sessionId)).not.toBeNull();
    expect(svc.get(third.sessionId)).not.toBeNull();
    expect(svc.size()).toBe(2);
  });

  it('evicts the least-recently-beaten session, not the first inserted', async () => {
    process.env.STREAM_MAX_SESSIONS_PER_USER = '2';
    svc = new LiveSessionRegistry();
    svc.onModuleInit();

    const first = svc.create(BASE);
    await new Promise((r) => setTimeout(r, 5));
    const second = svc.create(BASE);
    // Beat `first` so `second` becomes the stalest entry.
    await new Promise((r) => setTimeout(r, 5));
    svc.heartbeat(first.sessionId, { position: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const third = svc.create(BASE);

    expect(svc.get(second.sessionId)).toBeNull();
    expect(svc.get(first.sessionId)).not.toBeNull();
    expect(svc.get(third.sessionId)).not.toBeNull();
    expect(svc.size()).toBe(2);
  });

  it('caps each user independently and never blocks a fresh session', () => {
    process.env.STREAM_MAX_SESSIONS_PER_USER = '2';
    svc = new LiveSessionRegistry();
    svc.onModuleInit();

    svc.create(BASE);
    svc.create(BASE);
    svc.create(BASE); // evicts alice's oldest, alice stays at 2
    svc.create({ ...BASE, userId: 99, username: 'bob' });

    expect(svc.size()).toBe(3);
    expect(svc.list().filter((s) => s.userId === 1)).toHaveLength(2);
  });

  it('does not cap anonymous (null userId) sessions', () => {
    process.env.STREAM_MAX_SESSIONS_PER_USER = '1';
    svc = new LiveSessionRegistry();
    svc.onModuleInit();

    svc.create({ ...BASE, userId: null, username: null });
    svc.create({ ...BASE, userId: null, username: null });
    svc.create({ ...BASE, userId: null, username: null });

    expect(svc.size()).toBe(3);
  });

  it('defaults the cap to 10 when the env var is unset', () => {
    delete process.env.STREAM_MAX_SESSIONS_PER_USER;
    svc = new LiveSessionRegistry();
    svc.onModuleInit();

    for (let i = 0; i < 11; i++) svc.create(BASE);
    // The 11th create evicts the oldest — the user never exceeds 10.
    expect(svc.size()).toBe(10);
  });
});
