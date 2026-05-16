import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

export type ImageType = 'media' | 'person' | 'episode';
export type MediaImageVariant = 'poster' | 'fanart';
export type ImageSize = 'thumb' | 'medium' | 'full';

/**
 * Per-(type, variant) mapping from our logical size to TMDB's native size
 * segment (https://image.tmdb.org/t/p/{size}/...). Only TMDB URLs benefit
 * from multi-size pre-fetching — non-TMDB sources fall back to a single
 * `full` download.
 *
 * Sizes are chosen for typical usage:
 * - thumb : grid tiles (home, library, search)
 * - medium: detail page poster, mobile fanart hero
 * - full  : player fanart, large desktop hero
 */
const TMDB_SIZE_MAP: Record<string, Partial<Record<ImageSize, string>>> = {
  'media/poster': { thumb: 'w185', medium: 'w500', full: 'original' },
  'media/fanart': { thumb: 'w300', medium: 'w780', full: 'original' },
  person: { thumb: 'w45', full: 'original' },
  episode: { thumb: 'w300', full: 'original' },
};

const TMDB_HOST = /^https?:\/\/image\.tmdb\.org\//;

function sizeMapKey(type: ImageType, variant?: MediaImageVariant): string {
  if (type === 'media') return `media/${variant ?? 'poster'}`;
  return type;
}

/** Replace the size segment in a TMDB image URL (returns null if not TMDB). */
function tmdbUrlAtSize(url: string, tmdbSize: string): string | null {
  const m = url.match(/^(https?:\/\/image\.tmdb\.org\/t\/p\/)[^/]+(\/.+)$/);
  if (!m) return null;
  return `${m[1]}${tmdbSize}${m[2]}`;
}

@Injectable()
export class ImageService {
  private readonly logger = new Logger(ImageService.name);
  private readonly baseDir = path.join(process.cwd(), 'images');

  /**
   * Download an image from a remote URL and store it locally. For TMDB URLs,
   * pre-fetches all configured sizes (thumb / medium / full) so the frontend
   * can request a smaller variant via `?size=thumb` without going back to
   * TMDB. Non-TMDB URLs fall back to a single `full` download.
   *
   * Returns the local API path (e.g. `/api/images/media/42/poster`) — same
   * path regardless of how many sizes were stored. Returns null if the
   * `full` download fails (smaller variants are best-effort, never fatal).
   */
  async downloadAndStore(
    remoteUrl: string,
    type: ImageType,
    id: number,
    variant?: MediaImageVariant,
  ): Promise<string | null> {
    const sizes = TMDB_SIZE_MAP[sizeMapKey(type, variant)] ?? {
      full: 'original',
    };
    const isTmdb = TMDB_HOST.test(remoteUrl);

    const fullDest = this.getDiskPath(type, id, variant, 'full');
    fs.mkdirSync(path.dirname(fullDest), { recursive: true });

    try {
      const fullUrl =
        isTmdb && sizes.full
          ? (tmdbUrlAtSize(remoteUrl, sizes.full) ?? remoteUrl)
          : remoteUrl;
      const res = await axios.get(fullUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
      });
      fs.writeFileSync(fullDest, res.data);
    } catch (err) {
      this.logger.warn(`Failed to download image ${remoteUrl}: ${err.message}`);
      return null;
    }

    if (isTmdb) {
      // Download the smaller variants in parallel — they're all independent
      // GETs on the TMDB CDN and each adds non-trivial latency. Best-effort:
      // a failure on one variant doesn't fail the whole call (the `full`
      // file is already on disk and the controller falls back to it).
      const variantJobs = (Object.entries(sizes) as [ImageSize, string][])
        .filter(([size]) => size !== 'full')
        .map(([size, tmdbSize]) => ({
          size,
          url: tmdbUrlAtSize(remoteUrl, tmdbSize),
        }))
        .filter((job): job is { size: ImageSize; url: string } => !!job.url);

      await Promise.all(
        variantJobs.map(async ({ size, url }) => {
          try {
            const sizedDest = this.getDiskPath(type, id, variant, size);
            const res = await axios.get(url, {
              responseType: 'arraybuffer',
              timeout: 15000,
            });
            fs.writeFileSync(sizedDest, res.data);
          } catch (err) {
            this.logger.warn(
              `Failed to download ${size} variant ${url}: ${err.message}`,
            );
          }
        }),
      );
    }

    return this.getApiPath(type, id, variant);
  }

  /**
   * Delete all images (every size) for a given entity.
   */
  deleteImages(type: ImageType, id: number): void {
    if (type === 'media') {
      fs.rmSync(path.join(this.baseDir, 'media', String(id)), {
        recursive: true,
        force: true,
      });
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
   * `full` keeps the legacy filename (no suffix) for backward compatibility
   * with images downloaded before multi-size support.
   */
  getDiskPath(
    type: ImageType,
    id: number,
    variant?: MediaImageVariant,
    size: ImageSize = 'full',
  ): string {
    const suffix = size === 'full' ? '' : `-${size}`;
    switch (type) {
      case 'media':
        return path.join(
          this.baseDir,
          'media',
          String(id),
          `${variant ?? 'poster'}${suffix}.jpg`,
        );
      case 'person':
        return path.join(this.baseDir, 'persons', `${id}${suffix}.jpg`);
      case 'episode':
        return path.join(this.baseDir, 'episodes', `${id}${suffix}.jpg`);
    }
  }

  /**
   * Public API path stored in DB. Always size-agnostic — clients append
   * `?size=thumb|medium|full` at request time.
   */
  getApiPath(type: ImageType, id: number, variant?: MediaImageVariant): string {
    switch (type) {
      case 'media':
        return `/api/images/media/${id}/${variant ?? 'poster'}`;
      case 'person':
        return `/api/images/person/${id}`;
      case 'episode':
        return `/api/images/episode/${id}`;
    }
  }
}
