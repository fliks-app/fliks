import { Injectable, Signal, effect, inject, signal, untracked } from '@angular/core';
import { episodeLabel } from '../../../shared/utils/media-play.util';
import { Media, MediaService } from '../api/media.service';
import type { DownloadTask } from '../download-cache.service';

/** What identifies a playing item; every output exposes this and nothing more. */
export interface NowPlayingId {
  mediaId: number;
  episodeId?: number;
}

/** Display metadata of a playing item; URLs are as the API gives them (resolve at the consumer). */
export interface NowPlayingMetadata {
  title: string;
  /** `S1:E2 - title`, empty for a movie. */
  episodeLabel: string;
  logoUrl: string | null;
  posterUrl: string | null;
  fanartUrl: string | null;
  stillUrl: string | null;
  /** The episode still, else the media fanart. */
  backdropUrl: string | null;
}

export const NO_NOW_PLAYING: NowPlayingMetadata = {
  title: '',
  episodeLabel: '',
  logoUrl: null,
  posterUrl: null,
  fanartUrl: null,
  stillUrl: null,
  backdropUrl: null,
};

const TTL_MS = 10 * 60_000;

/** Display metadata of the item being played, whichever output plays it. */
export function describeNowPlaying(media: Media, episodeId?: number): NowPlayingMetadata {
  const episode =
    episodeId != null
      ? media.seasons?.flatMap((s) => s.episodes ?? []).find((e) => e.id === episodeId)
      : undefined;
  const stillUrl = episode?.stillUrl ?? null;
  return {
    title: media.title,
    episodeLabel: (episodeId != null ? episodeLabel(media, episodeId) : null) ?? '',
    logoUrl: media.logoUrl ?? null,
    posterUrl: media.posterUrl ?? null,
    fanartUrl: media.fanartUrl ?? null,
    stillUrl,
    backdropUrl: stillUrl ?? media.fanartUrl ?? null,
  };
}

/** What an OS media session shows: the episode label as the title, the media's below it. */
export function mediaSessionText(meta: NowPlayingMetadata): { title: string; artist?: string } {
  return meta.episodeLabel ? { title: meta.episodeLabel, artist: meta.title } : { title: meta.title };
}

/** The one place that turns an item identity into display metadata: title, episode label, artwork. */
@Injectable({ providedIn: 'root' })
export class NowPlayingMetadataService {
  private readonly mediaService = inject(MediaService);
  private readonly cache = new Map<number, { media: Media; at: number }>();
  private readonly inflight = new Map<number, Promise<Media>>();

  /** Keeps a media a caller already loaded, so the next read of it does not refetch. */
  prime(media: Media): void {
    this.cache.set(media.id, { media, at: Date.now() });
  }

  /** The metadata when the media is already cached (an episode it lacks counts as a miss). */
  peek(id: NowPlayingId): NowPlayingMetadata | null {
    const hit = this.cache.get(id.mediaId);
    if (!hit || Date.now() - hit.at > TTL_MS) return null;
    if (id.episodeId != null && !episodeLabel(hit.media, id.episodeId)) return null;
    return describeNowPlaying(hit.media, id.episodeId);
  }

  /** The media, fetched once however many callers ask; a `preloaded` one skips the fetch. */
  async media(mediaId: number, preloaded?: Media): Promise<Media> {
    if (preloaded) this.prime(preloaded);
    const hit = this.cache.get(mediaId);
    if (hit && Date.now() - hit.at <= TTL_MS) return hit.media;
    let pending = this.inflight.get(mediaId);
    if (!pending) {
      pending = this.mediaService.getOne(mediaId);
      this.inflight.set(mediaId, pending);
      const done = () => this.inflight.delete(mediaId);
      pending.then((m) => { this.prime(m); done(); }, done);
    }
    return pending;
  }

  async load(id: NowPlayingId, preloaded?: Media): Promise<NowPlayingMetadata> {
    const media = await this.media(id.mediaId, preloaded);
    const hit = this.peek(id);
    if (hit) return hit;
    // The cached media predates the episode: read it again once.
    this.cache.delete(id.mediaId);
    return describeNowPlaying(await this.media(id.mediaId), id.episodeId);
  }

  /** The header of a downloaded item, which has to show without the network. */
  describeDownload(task: DownloadTask): NowPlayingMetadata {
    const m = /^S(\d+)E(\d+)\s*(.*)$/.exec(task.episodeLabel ?? '');
    return {
      ...NO_NOW_PLAYING,
      title: task.media?.title ?? '',
      episodeLabel: m ? `S${+m[1]}:E${+m[2]}${m[3] ? ` - ${m[3]}` : ''}` : (task.episodeLabel ?? ''),
      logoUrl: task.media?.logoUrl ?? null,
    };
  }

  /** Follows `id`: null while nothing plays or the media is loading, then its metadata. Call in an injection context. */
  track(id: () => NowPlayingId | null): Signal<NowPlayingMetadata | null> {
    const out = signal<NowPlayingMetadata | null>(null);
    let seq = 0;
    effect(() => {
      const wanted = id();
      const key = wanted && { mediaId: wanted.mediaId, episodeId: wanted.episodeId };
      untracked(() => {
        const mine = ++seq;
        if (!key) return out.set(null);
        const hit = this.peek(key);
        out.set(hit);
        if (hit) return;
        void this.load(key).then(
          (m) => { if (mine === seq) out.set(m); },
          () => {},
        );
      });
    });
    return out;
  }
}
