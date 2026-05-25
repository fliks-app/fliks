import { DeepPartial } from 'typeorm';
import { DownloadHistory, GrabSource } from './entities/download-history.entity';
import { Media } from './entities/media.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { decodeHtmlEntities } from '../../common/utils/decode-html-entities';

/**
 * Builds the partial entity for a freshly-grabbed `DownloadHistory` row.
 * Single source of truth for the column set and the relation casts so the
 * seven grab paths (movie / movie upgrade / episode / season manual /
 * season pack / per-episode fallback / scheduler auto-grab) stay in sync
 * and a missing field can't drift between them.
 *
 * - `media` accepts either a hydrated entity or a bare `{ id }` shape
 *   because some callers only have the id at hand.
 * - `indexerId` is optional: raw-URL paste flows have no indexer context
 *   and persist `indexer: null` so the Activity page renders no badge.
 */
export function buildGrabHistoryRow(args: {
  media: Media | { id: number };
  downloadClient: DownloadClient;
  sourceTitle: string;
  torrentHash: string | null | undefined;
  quality: string;
  grabSource: GrabSource;
  indexerId?: number | null;
}): DeepPartial<DownloadHistory> {
  return {
    media: args.media as Media,
    downloadClient: args.downloadClient,
    // Decode HTML entities ahead of persistence so the stored title
    // matches what qBittorrent renders (it decodes on display). Without
    // this normalisation the matcher's fallback name comparison drifts
    // and the orphan-handler eventually flips the row to `failed`.
    sourceTitle: decodeHtmlEntities(args.sourceTitle),
    torrentHash: args.torrentHash || undefined,
    quality: args.quality,
    status: 'grabbed',
    grabSource: args.grabSource,
    indexer:
      args.indexerId != null ? ({ id: args.indexerId } as Indexer) : null,
  };
}
