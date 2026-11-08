import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideBookmarkPlus,
  LucideArrowDown,
  LucideArrowUp,
  LucideChevronDown,
  LucideGauge,
  LucideHeart,
  LucideListMusic,
  LucideRepeat,
  LucideRepeat1,
  LucideShuffle,
  LucideStar,
  LucideMoon,
  LucidePause,
  LucidePlay,
  LucideRotateCcw,
  LucideRotateCw,
  LucideSkipBack,
  LucideSkipForward,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import {
  AudioPlayerService,
  SKIP_STEPS,
  SPEEDS,
  type AudioBookmark,
} from '../../core/services/audio-player/audio-player.service';
import { PREAMP_STEPS, REPLAY_GAINS } from '../../core/services/audio-player/replay-gain';
import { LikesApiService } from '../../core/services/api/likes-api.service';
import { MediaService } from '../../core/services/api/media.service';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { AlbumDetail } from '../../core/services/api/music.models';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { formatTime } from '../../core/utils/player.utils';
import { CachedSrcDirective } from '../directives/cached-src.directive';
import { TvRowDirective } from '../directives/tv-row.directive';
import { TvSectionDirective } from '../directives/tv-section.directive';

const SLEEP_STEPS = [5, 10, 15, 30, 45, 60];

/** The persistent mini-player bar and the full-screen audio player, mounted once in the layout. */
@Component({
  selector: 'app-audio-player',
  imports: [
    TranslatePipe,
    ResolveUrlPipe,
    CachedSrcDirective,
    TvRowDirective,
    TvSectionDirective,
    LucideBookmarkPlus,
    LucideArrowDown,
    LucideArrowUp,
    LucideChevronDown,
    LucideGauge,
    LucideHeart,
    LucideListMusic,
    LucideRepeat,
    LucideRepeat1,
    LucideShuffle,
    LucideStar,
    LucideMoon,
    LucidePause,
    LucidePlay,
    LucideRotateCcw,
    LucideRotateCw,
    LucideSkipBack,
    LucideSkipForward,
    LucideTrash2,
    LucideX,
  ],
  templateUrl: './audio-player.html',
})
export class AudioPlayerComponent {
  protected readonly audio = inject(AudioPlayerService);
  private readonly likes = inject(LikesApiService);
  private readonly mediaApi = inject(MediaService);
  private readonly musicApi = inject(MusicApiService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly clock = formatTime;
  protected readonly percent = computed(() => {
    const d = this.audio.duration();
    return d ? Math.min(100, (this.audio.position() / d) * 100) : 0;
  });
  /** The slider value while the user drags, so `timeupdate` doesn't snap the thumb back. */
  protected readonly scrub = signal<number | null>(null);
  protected readonly shown = computed(() => {
    const s = this.scrub();
    return s === null ? this.audio.position() : (s / 1000) * this.audio.duration();
  });
  protected readonly chapter = computed(() => this.audio.chapters()[this.audio.chapterIndex()] ?? null);
  protected readonly sleepLabel = computed(() => {
    const s = this.audio.sleep();
    return s?.kind === 'duration' ? this.clock(this.audio.sleepLeft()) : null;
  });

  protected readonly stars = [1, 2, 3, 4, 5];
  protected readonly fav = signal(false);
  protected readonly rating = signal<number | null>(null);
  private readonly albums = new Map<number, Promise<AlbumDetail | null>>();

  constructor() {
    effect(() => {
      const t = this.audio.musicMode() ? this.audio.track() : null;
      if (t) untracked(() => void this.loadTrackState(t.mediaId, t.itemId));
    });
    effect(() => {
      const el = this.dialog()?.nativeElement;
      if (!el) return;
      if (this.audio.expanded() && !el.open) el.showModal();
      else if (!this.audio.expanded() && el.open) el.close();
    });
  }

  protected onSeek(e: Event): void {
    void this.audio.seek((Number((e.target as HTMLInputElement).value) / 1000) * this.audio.duration());
    this.scrub.set(null);
  }

  protected cycleRate(): void {
    this.audio.setRate(SPEEDS[(SPEEDS.indexOf(this.audio.rate()) + 1) % SPEEDS.length]);
  }

  protected cycleSkipBack(): void {
    this.audio.setSkips(next(SKIP_STEPS, this.audio.skipBack()), this.audio.skipForward());
  }

  protected cycleSkipForward(): void {
    this.audio.setSkips(this.audio.skipBack(), next(SKIP_STEPS, this.audio.skipForward()));
  }

  /** Off, then each duration, then the end of the chapter, then off. */
  protected cycleSleep(): void {
    const s = this.audio.sleep();
    if (!s) this.audio.setSleep({ minutes: SLEEP_STEPS[0] });
    else if (s.kind === 'chapter') this.audio.setSleep(null);
    else {
      const minutes = SLEEP_STEPS[SLEEP_STEPS.indexOf(s.minutes) + 1];
      this.audio.setSleep(minutes ? { minutes } : 'chapter');
    }
  }

  /** The caller's favourite and rating come with the album detail. */
  private async loadTrackState(mediaId: number, itemId: number): Promise<void> {
    this.fav.set(false);
    this.rating.set(null);
    let album = this.albums.get(mediaId);
    if (!album) {
      album = this.mediaApi
        .getOne(mediaId)
        .then((m) => (m as { album?: AlbumDetail }).album ?? null)
        .catch(() => null);
      this.albums.set(mediaId, album);
    }
    const track = (await album)?.tracks.find((x) => x.itemId === itemId);
    if (track && this.audio.track()?.itemId === itemId) {
      this.fav.set(track.favourite);
      this.rating.set(track.rating);
    }
  }

  protected async toggleFavourite(): Promise<void> {
    const t = this.audio.track();
    if (!t) return;
    const target = { mediaId: t.mediaId, itemId: t.itemId };
    const was = this.fav();
    this.fav.set(!was);
    try {
      await (was ? this.likes.unlike(target) : this.likes.like(target));
    } catch {
      this.fav.set(was);
    }
  }

  /** Clicking the star that is already the rating clears it. */
  protected async rate(n: number): Promise<void> {
    const t = this.audio.track();
    if (!t) return;
    const was = this.rating();
    this.rating.set(was === n ? null : n);
    try {
      await (was === n ? this.musicApi.clearRating(t.itemId) : this.musicApi.rate(t.itemId, n));
    } catch {
      this.rating.set(was);
    }
  }

  protected cycleReplayGain(): void {
    this.audio.setReplayGain(next(REPLAY_GAINS, this.audio.replayGain()));
  }

  protected cyclePreamp(): void {
    this.audio.setPreamp(next(PREAMP_STEPS, this.audio.preamp()));
  }

  protected goTo(b: AudioBookmark): void {
    void this.audio.seek(b.position);
  }

  protected onDialogClose(): void {
    this.audio.collapse();
  }
}

function next<T>(steps: T[], value: T): T {
  return steps[(steps.indexOf(value) + 1) % steps.length];
}
