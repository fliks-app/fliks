import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { getImagesDir } from '../../common/constants/paths';

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
  episode: { thumb: 'w300', full: 'original' },
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
  private readonly baseDir = getImagesDir();

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
    const sizes = TMDB_SIZE_MAP[sizeMapKey(type, variant)] ?? {
      full: 'original',
    };
    const isTmdb = TMDB_HOST.test(remoteUrl);

    const fullDest = this.getDiskPath(type, id, variant, 'full');
    fs.mkdirSync(path.dirname(fullDest), { recursive: true });

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
      fs.writeFileSync(fullDest, buffer);
    } catch (err) {
      this.logger.warn(`Failed to download image ${remoteUrl}: ${err.message}`);
      return null;
    }

    // Derive the smaller variants by resizing the downloaded full locally, so
    // every provider yields the full size pipeline — not just TMDB, whose CDN
    // exposes per-size URLs. Best-effort per variant: the full is already saved.
    const asPng = variant === 'logo';
    const targets = (Object.entries(sizes) as [ImageSize, string][])
      .map(([size, token]) => ({ size, width: sizeTokenWidth(token) }))
      .filter(
        (t): t is { size: ImageSize; width: number } =>
          t.size !== 'full' && t.width != null,
      );

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
          fs.writeFileSync(this.getDiskPath(type, id, variant, size), out);
        } catch (err) {
          this.logger.warn(
            `Failed to resize ${size} variant for ${type}/${id}: ${err.message}`,
          );
        }
      }),
    );

    return this.getApiPath(type, id, variant);
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
