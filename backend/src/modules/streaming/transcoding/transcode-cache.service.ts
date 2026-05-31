import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { TRANSCODE_DIR } from '../../../common/constants/paths';
import { StreamLifetime } from '../lifetime-constants';

/**
 * Index entry for one cache directory. A cache directory holds every
 * quality rendition that was transcoded for a single
 * (userId, mediaFileId, profileHash) tuple. Quality renditions sit
 * under {@link cacheDir} as subdirectories.
 */
export interface CacheEntry {
  userId: number | null;
  mediaFileId: number;
  profileHash: string;
  cacheDir: string;
  perQuality: Map<string, QualityCache>;
  totalBytes: number;
  lastAccess: number;
}

export interface QualityCache {
  quality: string;
  hasInit: boolean;
  segments: Set<number>;
  bytes: number;
}

const CACHE_LAYOUT_ROOT = path.join(TRANSCODE_DIR, 'cache');

/**
 * In-memory index of the on-disk transcode cache. Scans the cache root
 * at boot, tracks segment / init writes as `TranscodingService` fans
 * them out, evicts entries by TTL + LRU. `lookup` returns the
 * authoritative entry the streaming controller can serve from before
 * spawning a fresh ffmpeg. TTL / max-bytes / GC cadence come from
 * `TRANSCODE_CACHE_*` env vars — see lifetime-constants.ts.
 */
@Injectable()
export class TranscodeCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TranscodeCacheService.name);
  private readonly entries = new Map<string, CacheEntry>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  /** Returns the cache directories currently backed by a live transcode
   *  session. GC never evicts a directory an active ffmpeg job is still
   *  writing to / serving from. Registered by TranscodingService (via
   *  {@link registerLiveDirProvider}) to avoid a circular import. */
  private liveDirProvider: (() => Set<string>) | null = null;

  private readonly ttlMs = StreamLifetime.cacheTtlMs();
  private readonly maxBytes = StreamLifetime.cacheMaxBytes();
  private readonly gcIntervalMs = StreamLifetime.cacheGcIntervalMs();

  async onModuleInit(): Promise<void> {
    await fsp.mkdir(CACHE_LAYOUT_ROOT, { recursive: true });
    await this.rebuildIndex();
    this.gcTimer = setInterval(() => {
      this.runGc().catch((err) =>
        this.log.warn(`gc tick failed: ${(err as Error).message}`),
      );
    }, this.gcIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /** Wire the live-session lookup {@link runGc} uses to skip directories an
   *  active ffmpeg job is still writing to / serving from. */
  registerLiveDirProvider(provider: () => Set<string>): void {
    this.liveDirProvider = provider;
  }

  /** True when `cacheDir` (a profile-level entry dir) holds, or is, a live
   *  session's directory. Session paths are quality subdirs of the entry dir,
   *  so a prefix match covers both levels. */
  private isLiveDir(cacheDir: string, live: Set<string>): boolean {
    for (const p of live) {
      if (p === cacheDir || p.startsWith(cacheDir + path.sep)) return true;
    }
    return false;
  }

  /** Resolve the entry for a (user, file, profile) triple, or null. */
  lookup(
    userId: number | null,
    mediaFileId: number,
    profileHash: string,
  ): CacheEntry | null {
    return this.entries.get(entryKey(userId, mediaFileId, profileHash)) ?? null;
  }

  /** Refresh `lastAccess` on a cache hit. */
  touch(entry: CacheEntry): void {
    entry.lastAccess = Date.now();
  }

  /**
   * Record that the ffmpeg job just finished writing a segment. Creates
   * the {@link QualityCache} entry on first call. Used by later phases
   * once the job manager is wired through this service.
   */
  recordSegmentWritten(
    entry: CacheEntry,
    quality: string,
    segIndex: number,
    sizeBytes: number,
  ): void {
    let q = entry.perQuality.get(quality);
    if (!q) {
      q = { quality, hasInit: false, segments: new Set(), bytes: 0 };
      entry.perQuality.set(quality, q);
    }
    if (!q.segments.has(segIndex)) {
      q.segments.add(segIndex);
      q.bytes += sizeBytes;
      entry.totalBytes += sizeBytes;
    }
    entry.lastAccess = Date.now();
  }

  /** Record presence of the init.mp4 / init_N.mp4 for a quality. */
  recordInitWritten(
    entry: CacheEntry,
    quality: string,
    sizeBytes: number,
  ): void {
    let q = entry.perQuality.get(quality);
    if (!q) {
      q = { quality, hasInit: false, segments: new Set(), bytes: 0 };
      entry.perQuality.set(quality, q);
    }
    if (!q.hasInit) {
      q.hasInit = true;
      q.bytes += sizeBytes;
      entry.totalBytes += sizeBytes;
    }
    entry.lastAccess = Date.now();
  }

  /**
   * Drop an entry from the index AND wipe its directory on disk.
   * Used by GC; later phases also invoke on explicit user stop when
   * no other live session references the entry.
   */
  async evict(entry: CacheEntry): Promise<void> {
    this.entries.delete(
      entryKey(entry.userId, entry.mediaFileId, entry.profileHash),
    );
    await fsp.rm(entry.cacheDir, { recursive: true, force: true });
  }

  /**
   * Live on-disk footprint of the cache, scanned fresh from the
   * filesystem. The in-memory index is only authoritative at boot — it
   * is not updated as ffmpeg writes segments mid-stream — so anything
   * that must reflect current usage (admin stats, manual purge) walks
   * the disk directly rather than trusting {@link totalBytes}. `entries`
   * counts (user, file, profile) directories; `bytes` is the file total.
   */
  async diskUsage(
    mediaFileId?: number,
    userId?: number,
  ): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    for (const fileDir of await this.matchingFileDirs(mediaFileId, userId)) {
      entries += 1;
      bytes += await dirBytes(fileDir);
    }
    return { entries, bytes };
  }

  /**
   * Manually wipe cache directories on disk and drop any matching
   * in-memory entries. Scope is the (mediaFileId, optional userId) pair:
   * passing only `mediaFileId` purges every profile across all users for
   * that file; adding `userId` restricts to that user; passing neither
   * purges the whole cache. Operates on the live filesystem, so it also
   * removes directories created since boot that the index never saw.
   */
  async purge(
    mediaFileId?: number,
    userId?: number,
  ): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    for (const fileDir of await this.matchingFileDirs(mediaFileId, userId)) {
      entries += 1;
      bytes += await dirBytes(fileDir);
      await fsp.rm(fileDir, { recursive: true, force: true });
    }
    for (const [key, entry] of this.entries) {
      if (mediaFileId != null && entry.mediaFileId !== mediaFileId) continue;
      if (userId != null && entry.userId !== userId) continue;
      this.entries.delete(key);
    }
    if (entries > 0) {
      this.log.log(
        `[purge] dropped ${entries} cached title${entries === 1 ? '' : 's'} (${formatBytes(bytes)})`,
      );
    }
    return { entries, bytes };
  }

  /**
   * Enumerate the (user, file) directories on disk matching the given
   * scope. One such directory holds every profile variant (`main`,
   * `-early`, `-remux`, `-a<N>`) for a single playback, so callers count
   * it as one cached title rather than one per internal variant. Mirrors
   * the {@link CACHE_LAYOUT_ROOT} layout (`root/userSeg/mediaFileId`).
   */
  private async matchingFileDirs(
    mediaFileId?: number,
    userId?: number,
  ): Promise<string[]> {
    const dirs: string[] = [];
    for (const userDir of await readdirSafe(CACHE_LAYOUT_ROOT)) {
      const uid = parseUserDir(userDir);
      if (uid === undefined) continue;
      if (userId != null && uid !== userId) continue;
      const userPath = path.join(CACHE_LAYOUT_ROOT, userDir);
      for (const fileDir of await readdirSafe(userPath)) {
        const fid = Number.parseInt(fileDir, 10);
        if (!Number.isFinite(fid)) continue;
        if (mediaFileId != null && fid !== mediaFileId) continue;
        dirs.push(path.join(userPath, fileDir));
      }
    }
    return dirs;
  }

  /**
   * Garbage collection pass:
   * 1. Refresh the index from disk so it reflects reality — dirs created
   *    since boot are seen, current sizes/mtimes are read, and externally
   *    removed dirs drop out. The in-memory index is otherwise only built at
   *    boot (the segment-write hooks are not on the ffmpeg path), so without
   *    this refresh post-boot dirs escape TTL+LRU and the byte total drifts.
   * 2. Evict by TTL.
   * 3. Evict least-recently-used until total bytes are back under the cap.
   *
   * Both eviction passes skip any directory a live transcode session is still
   * writing to / serving from, so GC can never wipe an active playback's cache.
   */
  async runGc(): Promise<void> {
    await this.rebuildIndex(/* quiet */ true);

    const live = this.liveDirProvider?.() ?? new Set<string>();
    const now = Date.now();

    const expired = [...this.entries.values()].filter(
      (entry) =>
        !this.isLiveDir(entry.cacheDir, live) &&
        now - entry.lastAccess > this.ttlMs,
    );
    for (const entry of expired) {
      await this.evict(entry);
    }

    let total = this.totalBytes();
    if (total <= this.maxBytes) return;

    const lru = [...this.entries.values()]
      .filter((entry) => !this.isLiveDir(entry.cacheDir, live))
      .sort((a, b) => a.lastAccess - b.lastAccess);
    for (const entry of lru) {
      if (total <= this.maxBytes) break;
      total -= entry.totalBytes;
      await this.evict(entry);
    }
  }

  /** Sum of on-disk bytes across every indexed entry. */
  totalBytes(): number {
    let n = 0;
    for (const entry of this.entries.values()) n += entry.totalBytes;
    return n;
  }

  /** Visible for tests / metrics. */
  size(): number {
    return this.entries.size;
  }

  /** Visible for tests. */
  cacheRoot(): string {
    return CACHE_LAYOUT_ROOT;
  }

  /**
   * Absolute directory where the segments for this (user, file, profile,
   * quality) tuple should be written. The transcoding service uses this
   * to spawn ffmpeg's HLS muxer at the right path.
   */
  cachePathFor(
    userId: number | null,
    mediaFileId: number,
    profileHash: string,
    quality?: string,
  ): string {
    const userSeg = userId == null ? 'anon' : `u${userId}`;
    const base = path.join(
      CACHE_LAYOUT_ROOT,
      userSeg,
      String(mediaFileId),
      profileHash,
    );
    return quality ? path.join(base, quality) : base;
  }

  /**
   * Return the in-memory entry for this triple, creating an empty one
   * on miss. Used by the transcoding service when a fresh ffmpeg job
   * starts writing into a new cache directory — subsequent
   * {@link recordSegmentWritten} calls land on the same entry.
   */
  ensureEntry(
    userId: number | null,
    mediaFileId: number,
    profileHash: string,
  ): CacheEntry {
    const key = entryKey(userId, mediaFileId, profileHash);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: CacheEntry = {
      userId,
      mediaFileId,
      profileHash,
      cacheDir: this.cachePathFor(userId, mediaFileId, profileHash),
      perQuality: new Map(),
      totalBytes: 0,
      lastAccess: Date.now(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  private async rebuildIndex(quiet = false): Promise<void> {
    const scanned = await this.scanIndexFromDisk();
    // Atomic swap: the clear + set loop is synchronous, so a concurrent
    // lookup() sees either the old index or the fully-rebuilt one, never a
    // half-populated map mid-scan.
    this.entries.clear();
    for (const [key, entry] of scanned) this.entries.set(key, entry);

    if (!quiet && this.entries.size > 0) {
      this.log.log(
        `[disk] indexed ${this.entries.size} cache entr${this.entries.size === 1 ? 'y' : 'ies'} (${formatBytes(this.totalBytes())})`,
      );
    }
  }

  /** Walk the cache root and build a fresh index map from disk. Pure — does
   *  not mutate {@link entries}; the caller swaps it in. */
  private async scanIndexFromDisk(): Promise<Map<string, CacheEntry>> {
    const result = new Map<string, CacheEntry>();
    let userDirs: string[];
    try {
      userDirs = await fsp.readdir(CACHE_LAYOUT_ROOT);
    } catch {
      return result;
    }

    for (const userDir of userDirs) {
      const userId = parseUserDir(userDir);
      if (userId === undefined) continue;
      const userPath = path.join(CACHE_LAYOUT_ROOT, userDir);
      let mediaDirs: string[];
      try {
        mediaDirs = await fsp.readdir(userPath);
      } catch {
        continue;
      }
      for (const mediaDir of mediaDirs) {
        const mediaFileId = Number.parseInt(mediaDir, 10);
        if (!Number.isFinite(mediaFileId)) continue;
        const mediaPath = path.join(userPath, mediaDir);
        let profileDirs: string[];
        try {
          profileDirs = await fsp.readdir(mediaPath);
        } catch {
          continue;
        }
        for (const profileHash of profileDirs) {
          const cacheDir = path.join(mediaPath, profileHash);
          const entry = await this.indexEntry(
            userId,
            mediaFileId,
            profileHash,
            cacheDir,
          );
          if (entry) {
            result.set(entryKey(userId, mediaFileId, profileHash), entry);
          }
        }
      }
    }
    return result;
  }

  private async indexEntry(
    userId: number | null,
    mediaFileId: number,
    profileHash: string,
    cacheDir: string,
  ): Promise<CacheEntry | null> {
    const perQuality = new Map<string, QualityCache>();
    let totalBytes = 0;
    let lastAccess = 0;

    let qualityDirs: string[];
    try {
      qualityDirs = await fsp.readdir(cacheDir);
    } catch {
      return null;
    }

    for (const quality of qualityDirs) {
      const qualityPath = path.join(cacheDir, quality);
      const q: QualityCache = {
        quality,
        hasInit: false,
        segments: new Set(),
        bytes: 0,
      };
      let files: string[];
      try {
        files = await fsp.readdir(qualityPath);
      } catch {
        continue;
      }
      for (const f of files) {
        const segIndex = parseSegmentIndex(f);
        const filePath = path.join(qualityPath, f);
        let size = 0;
        let mtime = 0;
        try {
          const stat = await fsp.stat(filePath);
          size = stat.size;
          mtime = stat.mtimeMs;
        } catch {
          continue;
        }
        if (f === 'init.mp4' || /^init_\d+\.mp4$/.test(f)) {
          q.hasInit = true;
        } else if (segIndex !== null) {
          q.segments.add(segIndex);
        } else {
          continue;
        }
        q.bytes += size;
        totalBytes += size;
        if (mtime > lastAccess) lastAccess = mtime;
      }
      if (q.hasInit || q.segments.size > 0) {
        perQuality.set(quality, q);
      }
    }

    if (perQuality.size === 0) return null;
    return {
      userId,
      mediaFileId,
      profileHash,
      cacheDir,
      perQuality,
      totalBytes,
      lastAccess: lastAccess || Date.now(),
    };
  }
}

function entryKey(
  userId: number | null,
  mediaFileId: number,
  profileHash: string,
): string {
  return `${userId ?? 'anon'}::${mediaFileId}::${profileHash}`;
}

function parseUserDir(dir: string): number | null | undefined {
  if (dir === 'anon') return null;
  const m = /^u(\d+)$/.exec(dir);
  if (!m) return undefined;
  return Number.parseInt(m[1], 10);
}

/** `readdir` that yields `[]` for a missing/unreadable directory. */
async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/** Recursively sum the byte size of every file under a directory. */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let items: import('fs').Dirent[];
  try {
    items = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      total += await dirBytes(full);
    } else {
      try {
        total += (await fsp.stat(full)).size;
      } catch {
        // File vanished mid-scan (GC / ffmpeg rename) — skip.
      }
    }
  }
  return total;
}

function parseSegmentIndex(filename: string): number | null {
  const m = /^seg-(\d+)\.(?:m4s|ts)$/.exec(filename);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
