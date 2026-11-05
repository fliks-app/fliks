import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideBookmarkPlus,
  LucideChevronDown,
  LucideGauge,
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
    LucideChevronDown,
    LucideGauge,
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

  constructor() {
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

  protected goTo(b: AudioBookmark): void {
    void this.audio.seek(b.position);
  }

  protected onDialogClose(): void {
    this.audio.collapse();
  }
}

function next(steps: number[], value: number): number {
  return steps[(steps.indexOf(value) + 1) % steps.length];
}
