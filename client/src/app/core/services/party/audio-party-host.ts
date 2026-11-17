import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { artistLine, toTrackRequest } from '../../../features/music/music-utils';
import { asAlbumMedia } from '../../../features/media-detail/album/album-media';
import { MediaService } from '../api/media.service';
import type { PartyItem, PartyItemIn } from '../api/party-api.service';
import type { MusicTrackRequest } from '../audio-player/music-queue';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { ToastService } from '../toast.service';
import type { DuckEngine } from './party-ducking';
import { isTrack, type PartyPlayable } from './party-item';
import type { PartyHost } from './party-sync';

/** A track request built from the programme row alone. */
const bare = (r: PartyItem, hiddenTitle: string): MusicTrackRequest => ({
  itemId: r.itemId!,
  mediaId: r.mediaId,
  title: r.hidden ? hiddenTitle : r.title,
  artists: '',
  albumTitle: r.seriesTitle ?? '',
  coverUrl: r.posterUrl,
  durationSeconds: null,
  gain: null,
  peak: null,
  albumGain: null,
  albumPeak: null,
});

/** Lends the one audio player to the party: the same host surface a video player has, over a track timeline. */
@Injectable({ providedIn: 'root' })
export class AudioPartyHost implements PartyHost {
  private readonly audio = inject(AudioPlayerService);
  private readonly media = inject(MediaService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly albums = new Map<number, Promise<ReturnType<typeof asAlbumMedia>>>();
  private opening: { itemId: number; run: Promise<boolean> } | null = null;

  private readonly never = signal(false).asReadonly();
  private readonly uiPaused = computed(() => !this.audio.playing());

  readonly playable: PartyPlayable = {
    ready: () => this.audio.partyReady(),
    item: () => {
      const t = this.audio.musicMode() ? this.audio.track() : null;
      return t ? { mediaId: t.mediaId, episodeId: undefined, itemId: t.itemId } : { mediaId: -1, episodeId: undefined };
    },
    paused: () => !this.audio.playing(),
    uiPaused: this.uiPaused,
    buffering: this.audio.buffering,
    ended: this.audio.ended,
    seekLocked: this.never,
    position: () => this.audio.position(),
    seek: (t) => void this.audio.seekLocal(t),
    play: () => this.audio.resume(),
    pause: async () => this.audio.pause(),
    sync: {
      slackS: 0.5,
      rate: { get: () => this.audio.elementRate(), set: (r) => this.audio.setElementRate(r) },
    },
  };

  private readonly duckEngine: DuckEngine = ((audio) => ({
    supportsVolume: true,
    get volume() {
      return audio.duckLevel();
    },
    set volume(v: number) {
      audio.setDuck(v);
    },
  }))(this.audio);

  output(): PartyPlayable {
    return this.playable;
  }

  engine(): DuckEngine {
    return this.duckEngine;
  }

  urlPartyId(): number {
    return 0;
  }

  releasePlayback(): void {}

  showControls(): void {}

  /** Leaving the party takes the track with it. */
  onBack(): void {
    this.albums.clear();
    void this.audio.close();
  }

  /** One load per track at a time: the party's start and its first state both ask for it. */
  openItem(item: PartyItem): Promise<boolean> {
    const itemId = item.itemId;
    if (itemId == null || !isTrack(item)) return Promise.resolve(false);
    if (this.opening?.itemId === itemId) return this.opening.run;
    const run = this.load(item.mediaId, itemId).finally(() => {
      if (this.opening?.run === run) this.opening = null;
    });
    this.opening = { itemId, run };
    return run;
  }

  /** The queue's track requests for these programme rows, one per row: a row whose album cannot be fetched (gone, masked) keeps its own fields so an edit sends it back. */
  async requests(rows: PartyItem[]): Promise<MusicTrackRequest[]> {
    return Promise.all(rows.map(async (r) => (await this.request(r.mediaId, r.itemId!)) ?? bare(r, this.translate.instant('party.proposal_hidden'))));
  }

  /** The programme's tracks become the audio queue, the loaded one keeps playing. */
  adopt(tracks: MusicTrackRequest[], index: number): void {
    this.audio.adoptQueue(tracks, index);
  }

  /** The programme row of the audio queue entry at `index`. */
  rowAt(index: number): PartyItemIn | null {
    const t = this.audio.queue()[index];
    return t ? { mediaId: t.mediaId, itemId: t.itemId } : null;
  }

  private async request(mediaId: number, itemId: number): Promise<MusicTrackRequest | null> {
    let fetched = this.albums.get(mediaId);
    if (!fetched) this.albums.set(mediaId, (fetched = this.media.getOne(mediaId).then(asAlbumMedia, () => null)));
    const album = await fetched;
    const track = album?.album.tracks.find((t) => t.itemId === itemId && t.hasFile);
    if (!album || !track) {
      this.albums.delete(mediaId);
      return null;
    }
    const edition = album.album.release;
    return toTrackRequest(track, {
      mediaId,
      title: album.title,
      coverUrl: edition?.coverUrl ?? album.posterUrl,
      artists: artistLine(album.album.artists),
      albumGain: edition?.albumGain ?? null,
      albumPeak: edition?.albumPeak ?? null,
    });
  }

  private async load(mediaId: number, itemId: number): Promise<boolean> {
    const req = await this.request(mediaId, itemId);
    if (!req) {
      this.toast.error(this.translate.instant('player.next_unavailable'));
      return false;
    }
    await this.audio.openForParty(req);
    return true;
  }
}
