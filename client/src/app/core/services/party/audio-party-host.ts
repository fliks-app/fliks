import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { artistLine, toTrackRequest } from '../../../features/music/music-utils';
import { asAlbumMedia } from '../../../features/media-detail/album/album-media';
import { MediaService } from '../api/media.service';
import type { PartyItem } from '../api/party-api.service';
import { AudioPlayerService, type AudioPartyRouter } from '../audio-player/audio-player.service';
import { ToastService } from '../toast.service';
import type { DuckEngine } from './party-ducking';
import type { PartyPlayable } from './party-item';
import type { PartyHost } from './party-sync';

/** Lends the one audio player to the party: the same host surface a video player has, over a track timeline. */
@Injectable({ providedIn: 'root' })
export class AudioPartyHost implements PartyHost {
  private readonly audio = inject(AudioPlayerService);
  private readonly media = inject(MediaService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
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
    void this.audio.close();
  }

  route(router: AudioPartyRouter): () => void {
    return this.audio.setPartyRouter(router);
  }

  /** One load per track at a time: the party's start and its first state both ask for it. */
  openItem(item: PartyItem): Promise<boolean> {
    const itemId = item.itemId;
    if (itemId == null) return Promise.resolve(false);
    if (this.opening?.itemId === itemId) return this.opening.run;
    const run = this.load(item.mediaId, itemId).finally(() => {
      if (this.opening?.run === run) this.opening = null;
    });
    this.opening = { itemId, run };
    return run;
  }

  private async load(mediaId: number, itemId: number): Promise<boolean> {
    const album = asAlbumMedia(await this.media.getOne(mediaId).catch(() => null));
    const track = album?.album.tracks.find((t) => t.itemId === itemId && t.hasFile);
    if (!album || !track) {
      this.toast.error(this.translate.instant('player.next_unavailable'));
      return false;
    }
    const edition = album.album.editions.find((e) => e.id === track.editionId);
    await this.audio.openForParty(
      toTrackRequest(track, {
        mediaId,
        title: album.title,
        coverUrl: edition?.coverUrl ?? album.posterUrl,
        artists: artistLine(album.album.artists),
        albumGain: edition?.albumGain ?? null,
        albumPeak: edition?.albumPeak ?? null,
      }),
    );
    return true;
  }
}
