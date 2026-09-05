import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { getDataDir } from '../../common/constants/paths';

// libvips defaults to one worker thread per core plus a decoded-image cache,
// pure overhead for one-shot resizes on a low-core, low-RAM box.
sharp.concurrency(1);
sharp.cache(false);

/** Caps concurrent download+resize work across the whole process (all
 *  fire-and-forget import/refresh chains share this one ceiling). */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

const downloadSemaphore = new Semaphore(3);

export type ImageType =
  | 'media'
  | 'person'
  | 'episode'
  | 'season'
  | 'request'
  | 'user';
/** Variant of a media image. `fanart-${N}` (N≥1) addresses the extra
 *  fanarts kept for randomised page backgrounds — they share `fanart`'s
 *  size pipeline (thumb / medium / full) so frontends can request any
 *  size without an extra round-trip to the source provider. */
export type MediaImageVariant =
  | 'poster'
  | 'fanart'
  | `fanart-${number}`
  | 'logo';
export type ImageSize = 'thumb' | 'medium' | 'full';

/**
 * Per-(type, variant) mapping from our logical size to a width token. `full`
 * fetches TMDB's `original`; the `w<px>` tokens set the pixel width each
 * smaller variant is resized to locally (provider-agnostic).
 *
 * Sizes are chosen for typical usage:
 * - thumb : grid tiles (home, library, search)
 * - medium: detail page poster, mobile fanart hero
 * - full  : player fanart, large desktop hero
 */
const TMDB_SIZE_MAP: Record<string, Partial<Record<ImageSize, string>>> = {
  'media/poster': { thumb: 'w185', medium: 'w500', full: 'original' },
  'media/fanart': { thumb: 'w300', medium: 'w780', full: 'original' },
  // Clearlogo (transparent PNG title treatment).
  'media/logo': { thumb: 'w185', medium: 'w500', full: 'original' },
  // Request card art — keyed by `{mediaType}-{tmdbId}` (TMDB ids are
  // namespaced per media type, so a movie and a series can share the same
  // number). Every request for the same title shares one stored file.
  'request/poster': { thumb: 'w185', medium: 'w500', full: 'original' },
  'request/fanart': { thumb: 'w300', medium: 'w780', full: 'original' },
  person: { thumb: 'w45', full: 'original' },
  episode: { thumb: 'w300', medium: 'w780', full: 'original' },
  season: { thumb: 'w185', medium: 'w500', full: 'original' },
};

const TMDB_HOST = /^https?:\/\/image\.tmdb\.org\//;

function sizeMapKey(type: ImageType, variant?: MediaImageVariant): string {
  if (type === 'media' || type === 'request') {
    const v = variant ?? 'poster';
    // Indexed fanarts share the parent `fanart` size pipeline.
    const base = /^fanart-\d+$/.test(v) ? 'fanart' : v;
    return `${type}/${base}`;
  }
  return type;
}

/** Replace the size segment in a TMDB image URL (returns null if not TMDB). */
function tmdbUrlAtSize(url: string, tmdbSize: string): string | null {
  const m = url.match(/^(https?:\/\/image\.tmdb\.org\/t\/p\/)[^/]+(\/.+)$/);
  if (!m) return null;
  return `${m[1]}${tmdbSize}${m[2]}`;
}

/** Target pixel width for a size token (`w500` → 500); null for `original`. */
function sizeTokenWidth(token: string): number | null {
  const m = /^w(\d+)$/.exec(token);
  return m ? Number(m[1]) : null;
}

@Injectable()
export class ImageService {
  private readonly logger = new Logger(ImageService.name);
  private readonly baseDir = getDataDir();
  /** Keyed by `type/id/variant`. Lets a second concurrent call for the same
   *  target join the first instead of racing it: two overlapping calls with
   *  different URLs would otherwise interleave writes and leave the sidecar
   *  and the bytes on disk permanently disagreeing. */
  private readonly inflight = new Map<string, Promise<string | null>>();

  /**
   * Download an image from a remote URL and store it locally, generating the
   * configured sizes (thumb / medium / full) by resizing the downloaded full
   * — so every provider yields the same size pipeline the frontend requests via
   * `?size=thumb`.
   *
   * Returns the local API path (e.g. `/api/images/media/42/poster`) — same
   * path regardless of how many sizes were stored. Returns null if the
   * `full` download fails (smaller variants are best-effort, never fatal).
   */
  async downloadAndStore(
    remoteUrl: string,
    type: ImageType,
    id: number | string,
    variant?: MediaImageVariant,
  ): Promise<string | null> {
    const key = `${type}/${id}/${variant ?? 'default'}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.doDownloadAndStore(remoteUrl, type, id, variant).finally(
      () => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }

  private async doDownloadAndStore(
    remoteUrl: string,
    type: ImageType,
    id: number | string,
    variant?: MediaImageVariant,
  ): Promise<string | null> {
    const sizes = TMDB_SIZE_MAP[sizeMapKey(type, variant)] ?? {
      full: 'original',
    };
    const isTmdb = TMDB_HOST.test(remoteUrl);

    const fullDest = this.getDiskPath(type, id, variant, 'full');
    const srcPath = this.getSrcPath(type, id, variant);
    const targets = (Object.entries(sizes) as [ImageSize, string][])
      .map(([size, token]) => ({ size, width: sizeTokenWidth(token) }))
      .filter(
        (t): t is { size: ImageSize; width: number } =>
          t.size !== 'full' && t.width != null,
      );

    const cached = await this.readCacheHit(
      remoteUrl,
      srcPath,
      fullDest,
      targets,
      type,
      id,
      variant,
    );
    if (cached) return cached;

    const release = await downloadSemaphore.acquire();
    try {
      await fs.promises.mkdir(path.dirname(fullDest), { recursive: true });

      let buffer: Buffer;
      try {
        const fullUrl =
          isTmdb && sizes.full
            ? (tmdbUrlAtSize(remoteUrl, sizes.full) ?? remoteUrl)
            : remoteUrl;
        const res = await axios.get<ArrayBuffer>(fullUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
        });
        buffer = Buffer.from(res.data);
        await this.writeFileAtomic(fullDest, buffer);
      } catch (err) {
        this.logger.warn(`Failed to download image ${remoteUrl}: ${err.message}`);
        return null;
      }

      // Derive the smaller variants by resizing the downloaded full locally, so
      // every provider yields the full size pipeline, not just TMDB, whose CDN
      // exposes per-size URLs. Best-effort per variant: the full is already saved.
      const asPng = variant === 'logo';
      await Promise.all(
        targets.map(async ({ size, width }) => {
          try {
            const resized = sharp(buffer).resize({
              width,
              withoutEnlargement: true,
            });
            const out = await (
              asPng ? resized.png() : resized.jpeg({ quality: 90 })
            ).toBuffer();
            await this.writeFileAtomic(
              this.getDiskPath(type, id, variant, size),
              out,
            );
          } catch (err) {
            this.logger.warn(
              `Failed to resize ${size} variant for ${type}/${id}: ${err.message}`,
            );
          }
        }),
      );

      // The path is stable across re-downloads, so a client that cached the old
      // bytes for `max-age` would keep showing them after a re-identification.
      // Stamping the content makes the URL move exactly when the image does.
      const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 8);
      // Holds the hash so a later cache hit returns the same `?v=` without the bytes.
      await this.writeFileAtomic(
        srcPath,
        JSON.stringify({ url: remoteUrl, hash }),
      );
      return `${this.getApiPath(type, id, variant)}?v=${hash}`;
    } finally {
      release();
    }
  }

  /** Write to a temp path then rename, so a crash mid-write can never leave a
   *  torn file at `dest`. */
  private async writeFileAtomic(
    dest: string,
    data: Buffer | string,
  ): Promise<void> {
    const tmp = `${dest}.tmp`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, dest);
  }

  /** Cached result if `remoteUrl` matches the sidecar and every expected file
   *  is still on disk; null otherwise (any mismatch means do the full work). */
  private async readCacheHit(
    remoteUrl: string,
    srcPath: string,
    fullDest: string,
    targets: { size: ImageSize }[],
    type: ImageType,
    id: number | string,
    variant?: MediaImageVariant,
  ): Promise<string | null> {
    try {
      const meta = JSON.parse(await fs.promises.readFile(srcPath, 'utf8')) as {
        url: string;
        hash: string;
      };
      if (meta.url !== remoteUrl) return null;
      await fs.promises.access(fullDest);
      for (const { size } of targets) {
        await fs.promises.access(this.getDiskPath(type, id, variant, size));
      }
      return `${this.getApiPath(type, id, variant)}?v=${meta.hash}`;
    } catch {
      return null;
    }
  }

  /** Sidecar path recording the source URL + content hash `full` was stored
   *  with, so a re-run with the same URL can skip the download and resizes. */
  private getSrcPath(
    type: ImageType,
    id: number | string,
    variant?: MediaImageVariant,
  ): string {
    const full = this.getDiskPath(type, id, variant, 'full');
    return full.slice(0, -path.extname(full).length) + '.src.json';
  }

  /**
   * Delete all images (every size) for a given entity.
   */
  deleteImages(type: ImageType, id: number | string): void {
    if (type === 'media' || type === 'request') {
      fs.rmSync(
        path.join(this.baseDir, type === 'media' ? 'media' : 'requests', String(id)),
        { recursive: true, force: true },
      );
      return;
    }

    for (const size of ['full', 'thumb', 'medium'] as ImageSize[]) {
      try {
        fs.unlinkSync(this.getDiskPath(type, id, undefined, size));
      } catch {
        // file doesn't exist for that size — ignore
      }
    }
    try {
      fs.unlinkSync(this.getSrcPath(type, id, undefined));
    } catch {
      // sidecar doesn't exist, ignore
    }
  }

  /**
   * Absolute path on disk for a given size (default: `full`).
   * `full` is the canonical, unsuffixed filename; `thumb`/`medium` add a
   * `-size` suffix, so images stored before multi-size support still resolve.
   */
  getDiskPath(
    type: ImageType,
    id: number | string,
    variant?: MediaImageVariant,
    size: ImageSize = 'full',
  ): string {
    const suffix = size === 'full' ? '' : `-${size}`;
    // Logos are transparent PNGs — keep the .png extension so sendFile serves
    // image/png (a .jpg-named PNG would be flattened/blocked under nosniff).
    const ext = variant === 'logo' ? 'png' : 'jpg';
    switch (type) {
      case 'media':
        return path.join(
          this.baseDir,
          'media',
          String(id),
          `${variant ?? 'poster'}${suffix}.${ext}`,
        );
      case 'request':
        return path.join(
          this.baseDir,
          'requests',
          String(id),
          `${variant ?? 'poster'}${suffix}.jpg`,
        );
      case 'person':
        return path.join(this.baseDir, 'persons', `${id}${suffix}.jpg`);
      case 'episode':
        return path.join(this.baseDir, 'episodes', `${id}${suffix}.jpg`);
      case 'season':
        return path.join(this.baseDir, 'seasons', `${id}${suffix}.jpg`);
      case 'user':
        return path.join(this.baseDir, 'users', `${id}${suffix}.jpg`);
    }
  }

  /**
   * Persist a user avatar from an in-memory buffer (already cropped and
   * downscaled to a square client-side) and return its size-agnostic API path.
   * Avatars are a single stored file — no size pipeline — so callers append a
   * cache-busting version to the path when they store it on the user.
   */
  storeAvatar(userId: number, buffer: Buffer): string {
    const dest = this.getDiskPath('user', userId);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);
    return this.getApiPath('user', userId);
  }

  /** Whether the full-size file for (type, id, variant) is already stored. */
  hasImage(
    type: ImageType,
    id: number | string,
    variant?: MediaImageVariant,
  ): boolean {
    return fs.existsSync(this.getDiskPath(type, id, variant));
  }

  /**
   * Public API path stored in DB. Always size-agnostic — clients append
   * `?size=thumb|medium|full` at request time.
   */
  getApiPath(
    type: ImageType,
    id: number | string,
    variant?: MediaImageVariant,
  ): string {
    switch (type) {
      case 'media':
        return `/api/images/media/${id}/${variant ?? 'poster'}`;
      case 'request':
        return `/api/images/request/${id}/${variant ?? 'poster'}`;
      case 'person':
        return `/api/images/person/${id}`;
      case 'episode':
        return `/api/images/episode/${id}`;
      case 'season':
        return `/api/images/season/${id}`;
      case 'user':
        return `/api/images/user/${id}`;
    }
  }
}
