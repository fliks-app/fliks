import * as fsp from 'fs/promises';
import * as path from 'path';
import type { CacheEntry, QualityCache } from './transcode-cache.service';
import { TranscodeCacheService } from './transcode-cache.service';

const CACHE_ROOT = path.join('/tmp/transcode', 'cache');

async function writeFile(p: string, size: number): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, Buffer.alloc(size, 0));
}

async function resetCacheRoot(): Promise<void> {
  await fsp.rm(CACHE_ROOT, { recursive: true, force: true });
  await fsp.mkdir(CACHE_ROOT, { recursive: true });
}

describe('TranscodeCacheService', () => {
  let svc: TranscodeCacheService;

  beforeEach(async () => {
    await resetCacheRoot();
    svc = new TranscodeCacheService();
  });

  afterEach(() => {
    svc.onModuleDestroy();
  });

  it('starts with an empty index when the cache root is empty', async () => {
    await svc.onModuleInit();
    expect(svc.size()).toBe(0);
    expect(svc.totalBytes()).toBe(0);
  });

  it('indexes existing cache directories on init', async () => {
    const dir = path.join(CACHE_ROOT, 'u42', '1234', 'a1b2c3d4e5', '720p');
    await writeFile(path.join(dir, 'init.mp4'), 100);
    await writeFile(path.join(dir, 'seg-0.m4s'), 1000);
    await writeFile(path.join(dir, 'seg-1.m4s'), 2000);
    await writeFile(path.join(dir, 'seg-3.m4s'), 1500);

    await svc.onModuleInit();
    expect(svc.size()).toBe(1);

    const entry = svc.lookup(42, 1234, 'a1b2c3d4e5');
    expect(entry).not.toBeNull();
    expect(entry!.totalBytes).toBe(100 + 1000 + 2000 + 1500);
    const q = entry!.perQuality.get('720p');
    expect(q?.hasInit).toBe(true);
    expect([...(q?.segments ?? [])].sort((a, b) => a - b)).toEqual([0, 1, 3]);
  });

  it('indexes ts and m4s segments interchangeably', async () => {
    const dir = path.join(CACHE_ROOT, 'u1', '99', 'aaaaaaaaaa', '1080p');
    await writeFile(path.join(dir, 'seg-0.ts'), 500);
    await writeFile(path.join(dir, 'seg-1.ts'), 500);
    await svc.onModuleInit();
    const entry = svc.lookup(1, 99, 'aaaaaaaaaa');
    expect(entry?.perQuality.get('1080p')?.segments.size).toBe(2);
  });

  it('skips a profile dir that has no init and no segments', async () => {
    const dir = path.join(CACHE_ROOT, 'u1', '1', 'xxxxxxxxxx', '720p');
    await fsp.mkdir(dir, { recursive: true });
    await svc.onModuleInit();
    expect(svc.size()).toBe(0);
  });

  it('handles anonymous entries (no user id)', async () => {
    const dir = path.join(CACHE_ROOT, 'anon', '7', 'bbbbbbbbbb', '480p');
    await writeFile(path.join(dir, 'seg-0.m4s'), 300);
    await svc.onModuleInit();
    expect(svc.lookup(null, 7, 'bbbbbbbbbb')).not.toBeNull();
  });

  it('records a segment write and updates totals', async () => {
    await svc.onModuleInit();
    const dir = path.join(CACHE_ROOT, 'u5', '8', 'cccccccccc');
    const entry: CacheEntry = {
      userId: 5,
      mediaFileId: 8,
      profileHash: 'cccccccccc',
      cacheDir: dir,
      perQuality: new Map<string, QualityCache>(),
      totalBytes: 0,
      lastAccess: Date.now(),
    };
    svc.recordSegmentWritten(entry, '720p', 0, 1024);
    svc.recordSegmentWritten(entry, '720p', 1, 2048);
    svc.recordSegmentWritten(entry, '720p', 0, 9999); // duplicate, ignored
    expect(entry.totalBytes).toBe(3072);
    expect(entry.perQuality.get('720p')?.segments.size).toBe(2);
  });

  it('evicts entries past their TTL on gc', async () => {
    const dir = path.join(CACHE_ROOT, 'u1', '1', 'dddddddddd', '720p');
    const seg = path.join(dir, 'seg-0.m4s');
    await writeFile(seg, 1000);
    // GC derives lastAccess from the newest file mtime; age it past the 4 h TTL.
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await fsp.utimes(seg, old, old);
    await svc.onModuleInit();
    await svc.runGc();
    expect(svc.size()).toBe(0);
    await expect(fsp.access(dir)).rejects.toBeDefined();
  });

  it('keeps fresh entries through gc', async () => {
    const dir = path.join(CACHE_ROOT, 'u1', '1', 'eeeeeeeeee', '720p');
    await writeFile(path.join(dir, 'seg-0.m4s'), 1000);
    await svc.onModuleInit();
    await svc.runGc();
    expect(svc.size()).toBe(1);
  });

  it('gc indexes dirs created after boot, then TTL-manages them', async () => {
    await svc.onModuleInit();
    expect(svc.size()).toBe(0);
    const dir = path.join(CACHE_ROOT, 'u9', '70', 'aaaaaaaaaa', '720p');
    const seg = path.join(dir, 'seg-0.m4s');
    await writeFile(seg, 4000);
    // Fresh post-boot dir: gc now sees it (boot index never did) and keeps it.
    await svc.runGc();
    expect(svc.size()).toBe(1);
    expect(svc.totalBytes()).toBe(4000);
    // Age it past TTL: the next gc reclaims it — post-boot dirs no longer escape.
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await fsp.utimes(seg, old, old);
    await svc.runGc();
    expect(svc.size()).toBe(0);
  });

  it('never evicts a directory backed by a live session, even past TTL', async () => {
    const dir = path.join(CACHE_ROOT, 'u1', '1', 'liveliveee', '720p');
    const seg = path.join(dir, 'seg-0.m4s');
    await writeFile(seg, 1000);
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000); // past TTL
    await fsp.utimes(seg, old, old);
    await svc.onModuleInit();
    // Session path is the quality subdir of the entry dir — matched by prefix.
    svc.registerLiveDirProvider(() => new Set([dir]));
    await svc.runGc();
    expect(svc.size()).toBe(1);
    await expect(fsp.access(dir)).resolves.toBeUndefined();
    // Session ends → next gc reclaims it.
    svc.registerLiveDirProvider(() => new Set());
    await svc.runGc();
    expect(svc.size()).toBe(0);
  });

  it('cachePathFor composes the expected directory shape', async () => {
    await svc.onModuleInit();
    expect(svc.cachePathFor(42, 7, 'a1b2c3d4e5', '1080p')).toBe(
      path.join(CACHE_ROOT, 'u42', '7', 'a1b2c3d4e5', '1080p'),
    );
    expect(svc.cachePathFor(null, 7, 'a1b2c3d4e5')).toBe(
      path.join(CACHE_ROOT, 'anon', '7', 'a1b2c3d4e5'),
    );
  });

  it('ensureEntry creates a new entry on miss and reuses on hit', async () => {
    await svc.onModuleInit();
    const a = svc.ensureEntry(3, 11, 'ffffffffff');
    const b = svc.ensureEntry(3, 11, 'ffffffffff');
    expect(a).toBe(b);
    expect(svc.size()).toBe(1);
    expect(svc.lookup(3, 11, 'ffffffffff')).toBe(a);
  });

  it('diskUsage reflects dirs created after boot that the index never saw', async () => {
    await svc.onModuleInit();
    expect(svc.size()).toBe(0);
    // Simulate ffmpeg writing a fresh cache dir mid-stream — the index
    // is not updated live, so size()/totalBytes() stay 0 while the disk
    // grows. diskUsage() must see the real bytes.
    const dir = path.join(CACHE_ROOT, 'u9', '70', 'aaaaaaaaaa', '720p');
    await writeFile(path.join(dir, 'init.mp4'), 100);
    await writeFile(path.join(dir, 'seg-0.m4s'), 4000);
    expect(svc.size()).toBe(0);
    expect(svc.totalBytes()).toBe(0);
    expect(await svc.diskUsage()).toEqual({ entries: 1, bytes: 4100 });
  });

  it('counts a title once even with multiple profile variants', async () => {
    await svc.onModuleInit();
    // One playback spawns a main variant + an early-start companion under
    // the same (user, file) dir — operators count that as one title.
    const main = path.join(CACHE_ROOT, 'u9', '70', 'aaaaaaaaaa', '720p');
    const early = path.join(CACHE_ROOT, 'u9', '70', 'aaaaaaaaaa-early', '720p');
    await writeFile(path.join(main, 'seg-0.m4s'), 4000);
    await writeFile(path.join(early, 'init.mp4'), 100);
    expect(await svc.diskUsage()).toEqual({ entries: 1, bytes: 4100 });

    const freed = await svc.purge(70);
    expect(freed).toEqual({ entries: 1, bytes: 4100 });
    await expect(fsp.access(path.join(CACHE_ROOT, 'u9', '70'))).rejects.toBeDefined();
  });

  it('purges every profile/user for a media file, wiping disk', async () => {
    const a = path.join(CACHE_ROOT, 'u1', '50', 'aaaaaaaaaa', '720p');
    const b = path.join(CACHE_ROOT, 'u2', '50', 'bbbbbbbbbb', '1080p');
    const other = path.join(CACHE_ROOT, 'u1', '51', 'cccccccccc', '720p');
    await writeFile(path.join(a, 'seg-0.m4s'), 1000);
    await writeFile(path.join(b, 'seg-0.m4s'), 2000);
    await writeFile(path.join(other, 'seg-0.m4s'), 500);
    await svc.onModuleInit();
    expect(svc.size()).toBe(3);

    const freed = await svc.purge(50);
    expect(freed).toEqual({ entries: 2, bytes: 3000 });
    expect(svc.size()).toBe(1);
    expect(svc.lookup(1, 51, 'cccccccccc')).not.toBeNull();
    await expect(fsp.access(a)).rejects.toBeDefined();
    await expect(fsp.access(b)).rejects.toBeDefined();
  });

  it('scopes a purge to a single user when userId is given', async () => {
    const a = path.join(CACHE_ROOT, 'u1', '60', 'aaaaaaaaaa', '720p');
    const b = path.join(CACHE_ROOT, 'u2', '60', 'bbbbbbbbbb', '720p');
    await writeFile(path.join(a, 'seg-0.m4s'), 1000);
    await writeFile(path.join(b, 'seg-0.m4s'), 2000);
    await svc.onModuleInit();

    const freed = await svc.purge(60, 1);
    expect(freed).toEqual({ entries: 1, bytes: 1000 });
    expect(svc.lookup(1, 60, 'aaaaaaaaaa')).toBeNull();
    expect(svc.lookup(2, 60, 'bbbbbbbbbb')).not.toBeNull();
  });

  it('drops entries whose dir was wiped externally on gc', async () => {
    const dir = path.join(CACHE_ROOT, 'u1', '1', 'gggggggggg', '720p');
    await writeFile(path.join(dir, 'seg-0.m4s'), 1000);
    await svc.onModuleInit();
    expect(svc.size()).toBe(1);
    const entry = svc.lookup(1, 1, 'gggggggggg')!;
    // Simulate TranscodingService wiping the dir without notifying us.
    await fsp.rm(entry.cacheDir, { recursive: true, force: true });
    await svc.runGc();
    expect(svc.size()).toBe(0);
  });
});

describe('TranscodeCacheService env overrides', () => {
  const ENV = process.env;
  beforeEach(() => {
    process.env = { ...ENV };
  });
  afterEach(() => {
    process.env = ENV;
  });

  it('honours TRANSCODE_CACHE_TTL_MS', () => {
    process.env.TRANSCODE_CACHE_TTL_MS = '1000';
    const svc = new TranscodeCacheService();
    // No public getter; assert by behaviour: a brand-new entry with
    // lastAccess of 2 s ago should be evicted under the 1 s TTL.
    expect((svc as unknown as { ttlMs: number }).ttlMs).toBe(1000);
  });

  it('falls back to default when env is unparseable', () => {
    process.env.TRANSCODE_CACHE_TTL_MS = 'not-a-number';
    const svc = new TranscodeCacheService();
    expect((svc as unknown as { ttlMs: number }).ttlMs).toBe(
      4 * 60 * 60 * 1000,
    );
  });
});
