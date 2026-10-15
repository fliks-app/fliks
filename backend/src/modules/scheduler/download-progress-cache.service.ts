import { Injectable } from '@nestjs/common';
import { bridgeConfigured, bridgeFetch } from '../bridge/server-bridge';
import type { SseEvent } from './events.service';

type Downloads = Extract<SseEvent, { type: 'download.progress' }>['downloads'];

/** Read side of the `download.progress` replay cache, which lives in fliks-server's hub. */
@Injectable()
export class DownloadProgressCacheService {
  /** The downloads last stated for a media, for a caller adding to them rather than replacing them. */
  async current(
    mediaId: number,
  ): Promise<{ downloads: Downloads } | undefined> {
    if (!bridgeConfigured()) return undefined;
    const res = (await bridgeFetch(
      `/internal/events/progress?mediaId=${mediaId}`,
    )) as { downloads: Downloads };
    return res.downloads.length ? res : undefined;
  }
}
