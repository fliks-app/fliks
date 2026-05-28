import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { TRANSCODE_DIR } from '../../../common/constants/paths';

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

/** Default 4 h since last access. */
const DEFAULT_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
/** Default 20 GB. */
const DEFAULT_CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024;
/** Default GC tick 5 min. */
const DEFAULT_CACHE_GC_INTERVAL_MS = 5 * 60 * 1000;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read-only index of the on-disk transcode cache. Phase 1: scans the
 * cache root at boot to build the in-memory index but does not yet
 * serve segments or respond to job writes. Lookup / GC plumbing is in
 * place so later phases can wire it without changing the public shape.
 */
@Injectable()
export class TranscodeCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TranscodeCacheService.name);
  private readonly entries = new Map<string, CacheEntry>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  private readonly ttlMs = readEnvInt(
    'TRANSCODE_CACHE_TTL_MS',
    DEFAULT_CACHE_TTL_MS,
  );
  private readonly maxBytes = readEnvInt(
    'TRANSCODE_CACHE_MAX_BYTES',
    DEFAULT_CACHE_MAX_BYTES,
  );
  private readonly gcIntervalMs = readEnvInt(
    'TRANSCODE_CACHE_GC_INTERVAL_MS',
    DEFAULT_CACHE_GC_INTERVAL_MS,
  );

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
   * Garbage collection pass. Evicts by TTL first; if total size remains
   * above {@link maxBytes}, evicts least-recently-used entries until
   * back under the threshold.
   */
  async runGc(): Promise<void> {
    const now = Date.now();
    const expired: CacheEntry[] = [];
    for (const entry of this.entries.values()) {
      if (now - entry.lastAccess > this.ttlMs) expired.push(entry);
    }
    for (const entry of expired) {
      await this.evict(entry);
    }

    let total = this.totalBytes();
    if (total <= this.maxBytes) return;

    const lru = [...this.entries.values()].sort(
      (a, b) => a.lastAccess - b.lastAccess,
    );
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

  private async rebuildIndex(): Promise<void> {
    this.entries.clear();
    let userDirs: string[];
    try {
      userDirs = await fsp.readdir(CACHE_LAYOUT_ROOT);
    } catch {
      return;
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
            this.entries.set(entryKey(userId, mediaFileId, profileHash), entry);
          }
        }
      }
    }

    if (this.entries.size > 0) {
      this.log.log(
        `[disk] indexed ${this.entries.size} cache entr${this.entries.size === 1 ? 'y' : 'ies'} (${formatBytes(this.totalBytes())})`,
      );
    }
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
