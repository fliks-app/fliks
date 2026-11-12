import { Injectable, Signal, effect, inject, signal, untracked } from '@angular/core';
import { episodeLabel } from '../../../shared/utils/media-play.util';
import { Media, MediaService } from '../api/media.service';
import { MusicApiService } from '../api/music-api.service';
import type { MusicTrackRequest } from '../audio-player/music-queue';
import type { DownloadTask } from '../download-cache.service';
import type { MediaType } from '../../enums/media-type.enum';

/** What identifies a playing item; every output exposes this and nothing more. */
export interface NowPlayingId {
  mediaId: number;
  episodeId?: number;
  /** The music track, whose media is the album. */
  itemId?: number;
}

/** Display metadata of a playing item; URLs are as the API gives them (resolve at the consumer). */
export interface NowPlayingMetadata {
  /** The track title for music, else the media title. */
  title: string;
  /** The track's artists, empty when not music. */
  artist: string;
  /** The album title, empty when not music. */
  album: string;
  /** The media's type, set even while a track lookup has not resolved. */
  kind: MediaType | null;
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
  artist: '',
  album: '',
  kind: null,
  episodeLabel: '',
  logoUrl: null,
  posterUrl: null,
  fanartUrl: null,
  stillUrl: null,
  backdropUrl: null,
};

const TTL_MS = 10 * 60_000;

/** Display metadata of the item being played, whichever output plays it. */
export function describeNowPlaying(media: Media, episodeId?: number, track?: MusicTrackRequest): NowPlayingMetadata {
  const episode =
    episodeId != null
      ? media.seasons?.flatMap((s) => s.episodes ?? []).find((e) => e.id === episodeId)
      : undefined;
  const stillUrl = episode?.stillUrl ?? null;
  return {
    title: track?.title ?? media.title,
    artist: track?.artists ?? '',
    album: track ? media.title : '',
    kind: media.type,
    episodeLabel: (episodeId != null ? episodeLabel(media, episodeId) : null) ?? '',
    logoUrl: media.logoUrl ?? null,
    posterUrl: media.posterUrl ?? null,
    fanartUrl: media.fanartUrl ?? null,
    stillUrl,
    backdropUrl: stillUrl ?? media.fanartUrl ?? null,
  };
}

/** What an OS media session shows: a track and its artists, else the episode label with the media's title below it. */
export function mediaSessionText(meta: NowPlayingMetadata): { title: string; artist?: string } {
  if (meta.album) return { title: meta.title, artist: meta.artist };
  return meta.episodeLabel ? { title: meta.episodeLabel, artist: meta.title } : { title: meta.title };
}

/** One display line: the title and its artists, or the title alone. */
export function nowPlayingLine(meta: Pick<NowPlayingMetadata, 'title' | 'artist'> | null): string {
  return meta ? [meta.title, meta.artist].filter(Boolean).join(' · ') : '';
}

/** The one place that turns an item identity into display metadata: title, episode label, artwork. */
@Injectable({ providedIn: 'root' })
export class NowPlayingMetadataService {
  private readonly mediaService = inject(MediaService);
  private readonly cache = new Map<number, { media: Media; at: number }>();
  private readonly inflight = new Map<number, Promise<Media>>();
  private readonly music = inject(MusicApiService);
  private readonly tracks = new Map<number, { track: MusicTrackRequest | null; at: number }>();
  private readonly trackInflight = new Map<number, Promise<MusicTrackRequest | null>>();

  /** Keeps a media a caller already loaded, so the next read of it does not refetch. */
  prime(media: Media): void {
    this.cache.set(media.id, { media, at: Date.now() });
  }

  /** The metadata when the media is already cached (an episode it lacks counts as a miss). */
  peek(id: NowPlayingId): NowPlayingMetadata | null {
    const hit = this.cache.get(id.mediaId);
    if (!hit || Date.now() - hit.at > TTL_MS) return null;
    if (id.episodeId != null && !episodeLabel(hit.media, id.episodeId)) return null;
    if (!this.wantsTrack(hit.media, id)) return describeNowPlaying(hit.media, id.episodeId);
    const t = this.tracks.get(id.itemId!);
    if (!t || Date.now() - t.at > TTL_MS) return null;
    return describeNowPlaying(hit.media, id.episodeId, t.track ?? undefined);
  }

  /** Keeps tracks a caller already loaded, so the next read of them does not refetch. */
  primeTracks(rows: readonly MusicTrackRequest[]): void {
    const at = Date.now();
    for (const track of rows) this.tracks.set(track.itemId, { track, at });
  }

  private wantsTrack(media: Media, id: NowPlayingId): boolean {
    return media.type === 'album' && id.itemId != null;
  }

  /** The track, fetched once however many callers ask; null when it cannot be read. */
  private track1(itemId: number): Promise<MusicTrackRequest | null> {
    const hit = this.tracks.get(itemId);
    if (hit && Date.now() - hit.at <= TTL_MS) return Promise.resolve(hit.track);
    let pending = this.trackInflight.get(itemId);
    if (!pending) {
      pending = this.music.trackRequests([itemId]).then(
        (rows) => rows[0] ?? null,
        () => null,
      ).then((track) => {
        this.tracks.set(itemId, { track, at: Date.now() });
        return track;
      });
      this.trackInflight.set(itemId, pending);
      void pending.then(() => this.trackInflight.delete(itemId));
    }
    return pending;
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
    let media = await this.media(id.mediaId, preloaded);
    // The cached media predates the episode: read it again once.
    if (id.episodeId != null && !episodeLabel(media, id.episodeId)) {
      this.cache.delete(id.mediaId);
      media = await this.media(id.mediaId);
    }
    const track = this.wantsTrack(media, id) ? await this.track1(id.itemId!) : null;
    return describeNowPlaying(media, id.episodeId, track ?? undefined);
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
    let shownMedia: number | null = null;
    effect(() => {
      const wanted = id();
      const key = wanted && { mediaId: wanted.mediaId, episodeId: wanted.episodeId, itemId: wanted.itemId };
      untracked(() => {
        const mine = ++seq;
        if (!key) {
          shownMedia = null;
          return out.set(null);
        }
        const hit = this.peek(key);
        // A track change inside one album keeps the shown value until the lookup resolves.
        if (hit || key.itemId == null || key.mediaId !== shownMedia) out.set(hit);
        shownMedia = key.mediaId;
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
