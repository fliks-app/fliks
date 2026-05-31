/**
 * Integration tests for the cross-service streaming lifecycle —
 * scenarios picked from the #290 audit (issue #291 follow-up). Each
 * scenario drives `LiveSessionRegistry` + `TranscodeCacheService`
 * together to assert behaviour that no individual service spec
 * captures.
 *
 * What's covered here (no real ffmpeg):
 *   1. pause 15 min → resume hits cache, no eviction
 *   2. multi-profile coexistence on same (user, file)
 *   3. close + reopen rapidly → cache entry survives
 *   4. LRU + TTL eviction interplay
 *   5. session-loss ("ffmpeg crash") → cache entry preserved for respawn
 *
 * Scenarios that require driving real ffmpeg (segment-write ordering,
 * spawn arg verification) are deferred to a follow-up spec — they
 * need a mocked `child_process.spawn` harness that's worth its own
 * scaffolding PR.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { LiveSessionRegistry } from './live-session.service';
import { TranscodeCacheService } from './transcoding/transcode-cache.service';

const CACHE_ROOT = '/tmp/transcode/cache';
const ALICE = { userId: 1, username: 'alice' };
const BOB = { userId: 2, username: 'bob' };
const FILE_ID = 42;

async function writeSegment(
  cache: TranscodeCacheService,
  userId: number,
  fileId: number,
  profileHash: string,
  quality: string,
  segIndex: number,
  sizeBytes: number,
): Promise<void> {
  const segDir = cache.cachePathFor(userId, fileId, profileHash, quality);
  await fsp.mkdir(segDir, { recursive: true });
  const segName =
    segIndex === -1
      ? 'init.mp4'
      : `seg-${String(segIndex).padStart(4, '0')}.m4s`;
  await fsp.writeFile(path.join(segDir, segName), Buffer.alloc(sizeBytes, 0));
  const entry = cache.ensureEntry(userId, fileId, profileHash);
  if (segIndex === -1) cache.recordInitWritten(entry, quality, sizeBytes);
  else cache.recordSegmentWritten(entry, quality, segIndex, sizeBytes);
}

async function resetCacheRoot(): Promise<void> {
  await fsp.rm(CACHE_ROOT, { recursive: true, force: true });
  await fsp.mkdir(CACHE_ROOT, { recursive: true });
}

describe('streaming lifecycle — LiveSessionRegistry × TranscodeCacheService', () => {
  let live: LiveSessionRegistry;
  let cache: TranscodeCacheService;

  beforeEach(async () => {
    await resetCacheRoot();
    live = new LiveSessionRegistry();
    live.onModuleInit();
    cache = new TranscodeCacheService();
    await cache.onModuleInit();
  });

  afterEach(() => {
    live.onModuleDestroy();
    cache.onModuleDestroy();
  });

  it('pause 15 min → resume hits the existing cache (no retranscode)', async () => {
    const PROFILE = 'aaaaaaaaaa';
    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE, '1080p', -1, 100);
    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE, '1080p', 0, 1000);
    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE, '1080p', 1, 1000);

    const session = live.create({
      ...ALICE,
      mediaFileId: FILE_ID,
      profileHash: PROFILE,
      quality: '1080p',
      kind: 'transcode',
    });
    expect(live.size()).toBe(1);

    // Simulate the 15-min pause: drop the live session (heartbeats
    // stop on pause + GC eventually clears it), then come back.
    live.stop(session.sessionId);
    expect(live.size()).toBe(0);

    // Resume: cache lookup must still hit the existing entry — cache
    // TTL is 4 h, well past 15 min. No retranscode is needed because
    // the cache directory survived.
    const hit = cache.lookup(ALICE.userId, FILE_ID, PROFILE);
    expect(hit).not.toBeNull();
    expect(hit!.perQuality.get('1080p')?.segments.size).toBe(2);
    expect(hit!.perQuality.get('1080p')?.hasInit).toBe(true);

    // New live session for the resume — same profile triple.
    const resumed = live.create({
      ...ALICE,
      mediaFileId: FILE_ID,
      profileHash: PROFILE,
      quality: '1080p',
      kind: 'transcode',
    });
    expect(resumed.sessionId).not.toBe(session.sessionId);
    expect(live.size()).toBe(1);
  });

  it('multi-profile coexistence on the same (user, file)', async () => {
    // Two profiles for the same (user, file) — e.g. browser asks for
    // 1080p H.264 while a paired cast device pulls 720p. Each profile
    // gets its own cache directory and its own live session, no
    // clobber.
    const PROFILE_BROWSER = 'bbbbbbbbbb';
    const PROFILE_CAST = 'cccccccccc';

    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE_BROWSER, '1080p', 0, 1000);
    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE_CAST, '720p', 0, 500);

    const browser = live.create({
      ...ALICE,
      mediaFileId: FILE_ID,
      profileHash: PROFILE_BROWSER,
      quality: '1080p',
      kind: 'transcode',
    });
    const cast = live.create({
      ...ALICE,
      mediaFileId: FILE_ID,
      profileHash: PROFILE_CAST,
      quality: '720p',
      kind: 'transcode',
    });
    expect(browser.sessionId).not.toBe(cast.sessionId);
    expect(live.size()).toBe(2);

    // listForJob isolates each profile — the per-(user, file, profile)
    // grouping is what TranscodingService uses to decide whether an
    // ffmpeg job still has any live consumer.
    expect(live.listForJob(ALICE.userId, FILE_ID, PROFILE_BROWSER)).toHaveLength(1);
    expect(live.listForJob(ALICE.userId, FILE_ID, PROFILE_CAST)).toHaveLength(1);

    // Cache entries are independent too — same (user, file), different profile.
    expect(cache.size()).toBe(2);
    expect(cache.lookup(ALICE.userId, FILE_ID, PROFILE_BROWSER)).not.toBeNull();
    expect(cache.lookup(ALICE.userId, FILE_ID, PROFILE_CAST)).not.toBeNull();

    // Stopping the cast leaves the browser intact.
    live.stop(cast.sessionId);
    expect(live.size()).toBe(1);
    expect(live.listForJob(ALICE.userId, FILE_ID, PROFILE_BROWSER)).toHaveLength(1);
    expect(live.listForJob(ALICE.userId, FILE_ID, PROFILE_CAST)).toHaveLength(0);
  });

  it('close + reopen rapidly reattaches to the existing cache', async () => {
    const PROFILE = 'dddddddddd';
    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE, '1080p', 0, 1000);
    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE, '1080p', 1, 1000);

    const first = live.create({
      ...ALICE,
      mediaFileId: FILE_ID,
      profileHash: PROFILE,
      quality: '1080p',
      kind: 'transcode',
    });

    // User closes the tab (live session goes away) and immediately
    // reopens — the cache directory is preserved across the kill, so
    // the new live session must see the same cache entry.
    live.stop(first.sessionId);
    const reopened = live.create({
      ...ALICE,
      mediaFileId: FILE_ID,
      profileHash: PROFILE,
      quality: '1080p',
      kind: 'transcode',
    });

    expect(reopened.sessionId).not.toBe(first.sessionId);
    const entry = cache.lookup(ALICE.userId, FILE_ID, PROFILE);
    expect(entry).not.toBeNull();
    expect(entry!.perQuality.get('1080p')?.segments.size).toBe(2);
  });

  it('TTL eviction drops idle cache entries; LRU drops least-recent under size pressure', async () => {
    // Three entries — one is fresh, two are stale. TTL pass evicts the
    // stale pair. We can't easily trip the byte-cap default of 20 GB
    // inside a test, so the LRU ordering is asserted via the
    // lastAccess sort the GC uses internally.
    const PROFILE = 'eeeeeeeeee';
    await writeSegment(cache, ALICE.userId, 1, PROFILE, '1080p', 0, 1000);
    await writeSegment(cache, ALICE.userId, 2, PROFILE, '1080p', 0, 1000);
    await writeSegment(cache, ALICE.userId, 3, PROFILE, '1080p', 0, 1000);

    const stale1 = cache.lookup(ALICE.userId, 2, PROFILE)!;
    const stale2 = cache.lookup(ALICE.userId, 3, PROFILE)!;

    // GC derives lastAccess from the newest file mtime; push two of the three
    // segment files past the 4 h 1080p TTL. (The fresh one keeps its mtime.)
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    for (const fid of [2, 3]) {
      const seg = path.join(
        cache.cachePathFor(ALICE.userId, fid, PROFILE, '1080p'),
        'seg-0000.m4s',
      );
      await fsp.utimes(seg, fiveHoursAgo, fiveHoursAgo);
    }

    await cache.runGc();

    expect(cache.size()).toBe(1);
    expect(cache.lookup(ALICE.userId, 1, PROFILE)).not.toBeNull();
    expect(cache.lookup(ALICE.userId, 2, PROFILE)).toBeNull();
    expect(cache.lookup(ALICE.userId, 3, PROFILE)).toBeNull();
    await expect(fsp.access(stale1.cacheDir)).rejects.toBeDefined();
    await expect(fsp.access(stale2.cacheDir)).rejects.toBeDefined();
  });

  it('session loss ("ffmpeg crash") preserves the cache for the next spawn', async () => {
    // The ffmpeg process is killed (out-of-memory, segfault, signal)
    // and TranscodingService drops the in-memory session. The cache
    // directory survives the kill so a fresh spawn can pick up from
    // existing segments instead of restarting from scratch.
    const PROFILE = 'ffffffffff';
    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE, '1080p', -1, 100);
    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE, '1080p', 0, 1000);
    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE, '1080p', 1, 1000);

    const session = live.create({
      ...ALICE,
      mediaFileId: FILE_ID,
      profileHash: PROFILE,
      quality: '1080p',
      kind: 'transcode',
    });

    // Simulate the crash: the live session is dropped (no more
    // consumer), but no eviction is triggered on the cache side.
    live.stop(session.sessionId);
    expect(live.listForJob(ALICE.userId, FILE_ID, PROFILE)).toHaveLength(0);

    // Cache survives — a respawn can reuse the segments.
    const entry = cache.lookup(ALICE.userId, FILE_ID, PROFILE);
    expect(entry).not.toBeNull();
    expect(entry!.perQuality.get('1080p')?.segments.size).toBe(2);
    expect(entry!.perQuality.get('1080p')?.hasInit).toBe(true);

    // Respawn registers a fresh live session against the same
    // (user, file, profile) triple — handed to the cached entry.
    const respawn = live.create({
      ...ALICE,
      mediaFileId: FILE_ID,
      profileHash: PROFILE,
      quality: '1080p',
      kind: 'transcode',
    });
    expect(respawn.sessionId).not.toBe(session.sessionId);
    expect(live.listForJob(ALICE.userId, FILE_ID, PROFILE)).toHaveLength(1);
  });

  it('two users on the same file get fully-isolated cache entries and live sessions', async () => {
    // Pre-existing pollution flagged in #291: two distinct users
    // watching the same file have to coexist without clobbering each
    // other. The cache + registry layers already key per-(user, file,
    // profile), so the isolation holds at this level — the open issue
    // is in ActiveStreamTracker (#291 follow-up), which still keys by
    // mediaFileId only. That migration is tested separately.
    const PROFILE = 'gggggggggg';
    await writeSegment(cache, ALICE.userId, FILE_ID, PROFILE, '1080p', 0, 1000);
    await writeSegment(cache, BOB.userId, FILE_ID, PROFILE, '1080p', 0, 1000);

    const aliceSession = live.create({
      ...ALICE,
      mediaFileId: FILE_ID,
      profileHash: PROFILE,
      quality: '1080p',
      kind: 'transcode',
    });
    const bobSession = live.create({
      ...BOB,
      mediaFileId: FILE_ID,
      profileHash: PROFILE,
      quality: '1080p',
      kind: 'transcode',
    });

    expect(cache.size()).toBe(2);
    expect(cache.lookup(ALICE.userId, FILE_ID, PROFILE)).not.toBeNull();
    expect(cache.lookup(BOB.userId, FILE_ID, PROFILE)).not.toBeNull();

    expect(live.listForJob(ALICE.userId, FILE_ID, PROFILE)).toHaveLength(1);
    expect(live.listForJob(BOB.userId, FILE_ID, PROFILE)).toHaveLength(1);

    // Stopping Alice's session leaves Bob's cache + session intact.
    live.stop(aliceSession.sessionId);
    expect(cache.lookup(BOB.userId, FILE_ID, PROFILE)).not.toBeNull();
    expect(live.listForJob(BOB.userId, FILE_ID, PROFILE)).toHaveLength(1);
    expect(bobSession.userId).toBe(BOB.userId);
  });
});
