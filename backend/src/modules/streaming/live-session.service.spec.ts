import { LiveSessionRegistry } from './live-session.service';

const BASE = {
  sessionId: 'eng-1',
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
  });

  it('keeps the sid the engine issued, and does not split or cap it itself', () => {
    const a = svc.create(BASE);
    const b = svc.create({ ...BASE, sessionId: 'eng-2' });
    expect([a.sessionId, b.sessionId]).toEqual(['eng-1', 'eng-2']);
    expect(b.profileHash).toBe(BASE.profileHash);
    expect(svc.size()).toBe(2);
  });

  it('replaces the presence a resync built before the open finished', () => {
    svc.create({ ...BASE, mediaTitle: 'from tags' });
    svc.create({ ...BASE, mediaTitle: 'full' });
    expect(svc.size()).toBe(1);
    expect(svc.peek('eng-1')!.mediaTitle).toBe('full');
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

  it('stop removes the session, ends its QoE and returns whether it was known', () => {
    const qoe = { sessionEnded: jest.fn() };
    svc = new LiveSessionRegistry(qoe as never);
    const session = svc.create(BASE);
    expect(svc.stop(session.sessionId)).toBe(true);
    expect(svc.stop(session.sessionId)).toBe(false);
    expect(qoe.sessionEnded).toHaveBeenCalledTimes(1);
    expect(svc.size()).toBe(0);
  });

  it('list returns Date-typed snapshots', () => {
    const session = svc.create(BASE);
    const snapshots = svc.list();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].sessionId).toBe(session.sessionId);
    expect(snapshots[0].startedAt).toBeInstanceOf(Date);
    expect(snapshots[0].lastBeat).toBeInstanceOf(Date);
  });
});
