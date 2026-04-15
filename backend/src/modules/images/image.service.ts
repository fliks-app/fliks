import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

export type ImageType = 'media' | 'person' | 'episode';
export type MediaImageVariant = 'poster' | 'fanart';

@Injectable()
export class ImageService {
  private readonly logger = new Logger(ImageService.name);
  private readonly baseDir = path.join(process.cwd(), 'images');

  /**
   * Download an image from a remote URL and store it locally.
   * Returns the local API path (e.g. `/api/images/media/42/poster`).
   * Returns null if download fails.
   */
  async downloadAndStore(
    remoteUrl: string,
    type: ImageType,
    id: number,
    variant?: MediaImageVariant,
  ): Promise<string | null> {
    try {
      const dest = this.getDiskPath(type, id, variant);
      fs.mkdirSync(path.dirname(dest), { recursive: true });

      const response = await axios.get(remoteUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
      });
      fs.writeFileSync(dest, response.data);

      return this.getApiPath(type, id, variant);
    } catch (err) {
      this.logger.warn(`Failed to download image ${remoteUrl}: ${err.message}`);
      return null;
    }
  }

  /**
   * Delete all images for a given entity.
   */
  deleteImages(type: ImageType, id: number): void {
    const dir =
      type === 'media' ? path.join(this.baseDir, 'media', String(id)) : null;

    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    // Single file for person/episode
    const variants =
      type === 'person'
        ? [this.getDiskPath('person', id)]
        : [this.getDiskPath('episode', id)];

    for (const f of variants) {
      try {
        fs.unlinkSync(f);
      } catch {
        // file doesn't exist, ignore
      }
    }
  }

  /**
   * Absolute path on disk.
   */
  getDiskPath(
    type: ImageType,
    id: number,
    variant?: MediaImageVariant,
  ): string {
    switch (type) {
      case 'media':
        return path.join(
          this.baseDir,
          'media',
          String(id),
          `${variant ?? 'poster'}.jpg`,
        );
      case 'person':
        return path.join(this.baseDir, 'persons', `${id}.jpg`);
      case 'episode':
        return path.join(this.baseDir, 'episodes', `${id}.jpg`);
    }
  }

  /**
   * Public API path stored in DB.
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
