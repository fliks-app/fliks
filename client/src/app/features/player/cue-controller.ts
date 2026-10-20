import { computed, signal, untracked, type WritableSignal } from '@angular/core';
import { inIntroRange, inOutroRange } from '../../core/utils/player.utils';
import type { QueueItem } from '../../core/services/playback-queue.service';
import type { ControlsVisibilityService } from './controls/controls-visibility';
import type { EdlController } from './edl-controller';
import { PausableTimeout } from './pausable-timeout';

export interface CueHost {
  edl: EdlController;
  chrome: ControlsVisibilityService;
  preRollActive(): boolean;
  introMarker(): { startSeconds: number; endSeconds: number } | null;
  outroMarker(): { startSeconds: number; endSeconds: number } | null;
  currentTime(): number;
  upNext(): QueueItem | null;
  /** The viewer is on the controls bar or on the cue itself. */
  engaged(): boolean;
  hasEngine(): boolean;
  /** Move the playhead the way a user seek does. */
  seek(to: number): void;
}

/** The floating skip-intro, skip-ad and next-episode cues. Each surfaces once per range entry
 *  and retracts on its own; the countdown freezes while the viewer is engaged with the controls. */
export class CueController {
  /** Lifetime of a cue, also the duration of its progress sweep in the controls. */
  readonly cueRevealMs = 10000;
  readonly skipIntroVisible = signal(false);
  readonly nextEpisodeVisible = signal(false);
  /** Skip ad cue, shown on the skip-intro button while a commercial is not auto-skipped. */
  readonly commercialCueVisible = signal(false);
  /** Identity of the cue on the button, so its sweep and countdown restart when it changes. */
  readonly skipCueKey = computed(() => {
    const c = this.commercialCueVisible() ? this.host.edl.commercialCue() : null;
    return c ? `ad:${c.fileId}:${c.index}` : 'intro';
  });
  /** True when the playhead is inside the detected intro. */
  readonly inIntroRange = computed(
    () => !this.host.preRollActive() && inIntroRange(this.host.introMarker(), this.host.currentTime()),
  );
  /** True when the playhead is in the outro and something follows. */
  readonly showNextEpisodeButton = computed(
    () => inOutroRange(this.host.outroMarker(), this.host.currentTime()) && this.host.upNext() !== null,
  );

  private readonly skipIntroCue = new PausableTimeout(() => this.skipIntroVisible.set(false));
  private readonly nextEpisodeCue = new PausableTimeout(() => this.nextEpisodeVisible.set(false));
  private readonly commercialCue = new PausableTimeout(() => this.commercialCueVisible.set(false));
  private commercialCueKey: string | null = null;
  private skipIntroCueArmed = false;
  private nextEpisodeCueArmed = false;

  constructor(private readonly host: CueHost) {}

  /** Freezes the retract timers while the viewer is engaged, resumes them otherwise. */
  syncTimers(): void {
    if (this.host.engaged()) {
      this.skipIntroCue.pause();
      this.nextEpisodeCue.pause();
      this.commercialCue.pause();
    } else {
      this.skipIntroCue.resume();
      this.nextEpisodeCue.resume();
      this.commercialCue.resume();
    }
  }

  /** Reveals the skip-intro cue once each time the playhead enters the intro. */
  syncIntroCue(): void {
    if (this.inIntroRange()) {
      if (this.skipIntroCueArmed) return;
      this.skipIntroCueArmed = true;
      this.revealCue(this.skipIntroVisible, this.skipIntroCue);
    } else if (this.skipIntroCueArmed) {
      this.skipIntroCueArmed = false;
      this.hideCue(this.skipIntroVisible, this.skipIntroCue);
    }
  }

  /** Reveals the Skip ad cue once each time the playhead enters an unskipped commercial. */
  syncCommercialCue(): void {
    const c = this.host.edl.commercialCue();
    const key = c ? `${c.fileId}:${c.index}` : null;
    if (key === this.commercialCueKey) return;
    this.commercialCueKey = key;
    if (key === null) this.hideCue(this.commercialCueVisible, this.commercialCue);
    else this.revealCue(this.commercialCueVisible, this.commercialCue);
  }

  /** Reveals the next-episode cue once each time the playhead enters the outro. */
  syncNextEpisodeCue(): void {
    if (this.showNextEpisodeButton()) {
      if (this.nextEpisodeCueArmed) return;
      this.nextEpisodeCueArmed = true;
      this.revealCue(this.nextEpisodeVisible, this.nextEpisodeCue);
    } else if (this.nextEpisodeCueArmed) {
      this.nextEpisodeCueArmed = false;
      this.hideCue(this.nextEpisodeVisible, this.nextEpisodeCue);
    }
  }

  /** Skip button click: the commercial when its cue is up, else the intro. */
  onSkipCue(): void {
    if (!this.commercialCueVisible()) return this.skipIntro();
    const t = this.host.edl.skipCommercial();
    if (t !== null) this.host.seek(t);
    this.host.chrome.resetHideTimer();
  }

  /** Seek to the end of the intro. */
  skipIntro(): void {
    const m = this.host.introMarker();
    if (!m || !this.host.hasEngine()) return;
    const t = this.host.edl.resolveSeek(m.endSeconds);
    if (t === null) return;
    this.host.seek(t);
    this.host.chrome.resetHideTimer();
  }

  cancelTimers(): void {
    this.skipIntroCue.cancel();
    this.nextEpisodeCue.cancel();
    this.commercialCue.cancel();
  }

  /** Starts frozen if the controls bar is already up, so the cue waits for the viewer to look away. */
  private revealCue(visible: WritableSignal<boolean>, cue: PausableTimeout): void {
    visible.set(true);
    cue.start(this.cueRevealMs);
    if (untracked(this.host.chrome.visible)) cue.pause();
  }

  private hideCue(visible: WritableSignal<boolean>, cue: PausableTimeout): void {
    cue.cancel();
    visible.set(false);
  }
}
