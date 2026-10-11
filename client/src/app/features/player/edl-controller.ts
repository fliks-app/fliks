import { computed, signal } from '@angular/core';
import type { EngineEventMap, PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import { EdlSkipPolicy, muteRangesOf, type EdlRange } from '../../core/utils/edl-policy';

export interface EdlHost {
  engine(): PlaybackEngine | null;
  /** False while casting or during a pre-roll: the local engine is not the one being watched. */
  active(): boolean;
  duration(): number;
  /** Move the playhead without counting as a user seek. */
  seek(to: number): void;
  /** Natural end of the file: pause and latch `ended`. */
  end(): void;
}

const NOTICE_MS = 2500;
/** A timer that wakes this close to a boundary counts as having reached it. */
const REACHED_SLACK_S = 0.03;
/** How long timeUpdates still reporting the pre-seek position are ignored. */
const STALE_POSITION_MS = 3000;
/** A seek to the same target inside this window is not repeated (an engine landing short). */
const RESEEK_GUARD_MS = 3000;
/** Position reports older than this are not extrapolated. */
const EXTRAPOLATE_MAX_MS = 1500;

/** Applies the EDL skip policy to the local engine: timers extrapolated from the last
 *  position report, resolution of start positions and user seeks, and the mute ranges. */
export class EdlController {
  /** Ranges of the current file; drives the seekbar bands and the mute badge. */
  readonly ranges = signal<readonly EdlRange[]>([]);
  readonly muteRanges = computed(() => muteRangesOf(this.ranges()));
  /** The skip being announced, cleared after a few seconds. */
  readonly notice = signal<'cut' | 'commercial' | null>(null);
  /** The unskipped commercial under the playhead while auto-skip is off, for the Skip ad cue. */
  readonly commercialCue = signal<{ fileId: number; index: number; start: number; end: number } | null>(null);

  private autoSkipCommercials = true;
  private fileId: number | null = null;
  private policy: EdlSkipPolicy | null = null;
  private engine: PlaybackEngine | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPos = 0;
  private lastAt = 0;
  private buffering = false;
  private pendingTo: number | null = null;
  private pendingAt = 0;
  private endPending = false;
  private endFired = false;
  private pushedMutes = '[]';
  private rangesVersion = 0;
  private lastSeekTo = -1;
  private lastSeekAt = 0;
  /** Set when a different file replaces the playing one, until its load settles. */
  private awaitingLoad = false;
  private awaitingSince = 0;

  private readonly onTime = (e: EngineEventMap['timeUpdate']) => {
    const now = this.now();
    if (this.awaitingLoad) {
      if (now - this.awaitingSince < STALE_POSITION_MS * 2) return;
      this.awaitingLoad = false;
    }
    if (this.pendingTo !== null) {
      if (e.position >= this.pendingTo - 0.25 || now - this.pendingAt > STALE_POSITION_MS) {
        this.pendingTo = null;
      } else {
        return;
      }
    }
    this.lastPos = e.position;
    this.lastAt = now;
    this.tick();
  };

  private readonly onState = (e: EngineEventMap['stateChanged']) => {
    this.buffering = e.state === 'buffering';
    this.rearm();
  };

  constructor(
    private readonly host: EdlHost,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Adopt the ranges of `fileId`. The same file keeps its skipped commercials across reloads. */
  load(fileId: number, ranges: readonly EdlRange[] | undefined): void {
    const next = ranges ?? [];
    if (fileId !== this.fileId || !this.policy) {
      if (this.fileId !== null && fileId !== this.fileId) {
        this.awaitingLoad = true;
        this.awaitingSince = this.now();
      }
      this.fileId = fileId;
      this.lastSeekTo = -1;
      this.lastPos = 0;
      this.commercialCue.set(null);
      this.policy = next.length
        ? new EdlSkipPolicy(next, { autoSkipCommercials: this.autoSkipCommercials })
        : null;
      this.endPending = false;
      this.endFired = false;
      this.pendingTo = null;
    } else if (next.length) {
      this.policy.replaceRanges(next);
    } else {
      this.policy = null;
    }
    this.ranges.set(next);
    this.rangesVersion++;
    this.pushMutes();
    this.rearm();
  }

  /** Off: commercials are skipped only through skipCommercial(). */
  setAutoSkipCommercials(on: boolean): void {
    this.autoSkipCommercials = on;
    this.policy?.setAutoSkipCommercials(on);
    this.updateCue();
    this.rearm();
  }

  /** Skip ad pressed: the target to seek to, or null (none, or the file ends). */
  skipCommercial(): number | null {
    if (!this.policy || !this.host.active()) return null;
    const d = this.policy.skipCommercialAt(this.lastPos, this.host.duration());
    this.updateCue();
    if (d.kind === 'none') return null;
    if (d.kind === 'end') {
      this.fireEnd();
      return null;
    }
    this.pendingTo = d.to;
    this.pendingAt = this.now();
    this.lastPos = d.to;
    this.lastAt = this.pendingAt;
    return d.to;
  }

  /** The new file's engine.load resolved: its position reports can be trusted. */
  settle(): void {
    this.awaitingLoad = false;
    this.pendingTo = null;
    this.rearm();
  }

  /** Leaving the player or the file: drop the ranges and silence nothing. */
  clear(): void {
    this.fileId = null;
    this.policy = null;
    this.awaitingLoad = false;
    this.ranges.set([]);
    this.rangesVersion++;
    this.stopTimer();
    this.pushMutes();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.notice.set(null);
    this.commercialCue.set(null);
    this.detach();
  }

  attach(engine: PlaybackEngine): void {
    this.detach();
    this.engine = engine;
    engine.on('timeUpdate', this.onTime);
    engine.on('stateChanged', this.onState);
    this.pushedMutes = '';
    this.pushMutes();
  }

  /** Where playback should start: past any cut or commercial covering `t`. */
  resolveStart(t: number): number {
    if (!this.policy || !this.host.active()) return t;
    this.endFired = false;
    const d = this.policy.resolve(t, this.host.duration());
    if (d.kind === 'none') return t;
    this.announce(d.action);
    if (d.kind === 'end') {
      this.endPending = true;
      return t;
    }
    return d.to;
  }

  /** Target for a user seek, or null when it landed in a tail that ends the file. */
  resolveSeek(t: number): number | null {
    this.pendingTo = null;
    this.endPending = false;
    this.endFired = false;
    if (!this.policy || !this.host.active()) return t;
    const d = this.policy.resolve(t, this.host.duration());
    if (d.kind === 'none') return t;
    this.announce(d.action);
    if (d.kind === 'end') {
      this.fireEnd();
      return null;
    }
    this.lastPos = d.to;
    this.lastAt = this.now();
    this.updateCue();
    return d.to;
  }

  /** Re-sample the engine clock and re-arm the boundary timer (state or rate changed). */
  rearm(): void {
    this.stopTimer();
    const eng = this.engine;
    if (!eng || !this.policy) return;
    this.pushMutes();
    if (this.pendingTo !== null) return;
    const now = this.now();
    const cur = eng.currentTime;
    const dt = now - this.lastAt;
    const live = !eng.paused && !this.buffering && this.lastAt > 0 && dt < EXTRAPOLATE_MAX_MS;
    this.lastPos = live ? Math.max(cur, this.lastPos + (dt / 1000) * (eng.playbackRate || 1)) : cur;
    this.lastAt = now;
    this.arm();
  }

  private updateCue(): void {
    const r =
      !this.autoSkipCommercials && this.policy && this.host.active() && this.fileId !== null
        ? this.policy.commercialAt(this.lastPos)
        : null;
    const c = r && this.fileId !== null ? { fileId: this.fileId, ...r } : null;
    const cur = this.commercialCue();
    if (c?.index !== cur?.index || c?.fileId !== cur?.fileId) this.commercialCue.set(c);
  }

  private tick(): void {
    this.stopTimer();
    this.pushMutes();
    this.updateCue();
    if (!this.policy || !this.host.active()) {
      this.pushMutes();
      return;
    }
    if (this.endPending) {
      this.endPending = false;
      this.fireEnd();
      return;
    }
    if (this.apply(this.policy.resolve(this.lastPos, this.host.duration()))) return;
    this.arm();
  }

  private arm(): void {
    this.stopTimer();
    const eng = this.engine;
    if (!this.policy || !eng || !this.host.active() || eng.paused || this.buffering) return;
    const boundary = this.policy.nextBoundary(this.lastPos);
    if (boundary === null) return;
    const rate = eng.playbackRate || 1;
    const delay = ((boundary - this.lastPos) / rate) * 1000 - (this.now() - this.lastAt);
    this.timer = setTimeout(() => this.fire(boundary), Math.max(0, delay));
  }

  private fire(boundary: number): void {
    this.timer = null;
    const eng = this.engine;
    if (!this.policy || !eng || !this.host.active()) return;
    const now = this.now();
    const reached = this.lastPos + (((now - this.lastAt) / 1000) * (eng.playbackRate || 1));
    if (reached >= boundary - REACHED_SLACK_S) {
      this.lastPos = Math.max(reached, boundary);
      this.lastAt = now;
      if (this.apply(this.policy.resolve(boundary, this.host.duration()))) return;
    }
    this.arm();
  }

  private apply(d: ReturnType<EdlSkipPolicy['resolve']>): boolean {
    if (d.kind === 'none') return false;
    if (d.kind === 'seek' && d.to === this.lastSeekTo && this.now() - this.lastSeekAt < RESEEK_GUARD_MS) {
      return false;
    }
    this.announce(d.action);
    if (d.kind === 'end') {
      this.fireEnd();
      return true;
    }
    this.lastSeekTo = d.to;
    this.lastSeekAt = this.now();
    this.pendingTo = d.to;
    this.pendingAt = this.now();
    this.lastPos = d.to;
    this.lastAt = this.pendingAt;
    this.host.seek(d.to);
    this.arm();
    return true;
  }

  private fireEnd(): void {
    if (this.endFired) return;
    this.endFired = true;
    this.stopTimer();
    this.host.end();
  }

  private announce(action: 'cut' | 'commercial'): void {
    this.notice.set(action);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.notice.set(null);
    }, NOTICE_MS);
  }

  private pushMutes(): void {
    if (!this.engine) return;
    const on = this.policy !== null && this.host.active();
    const key = `${on}:${this.rangesVersion}`;
    if (key === this.pushedMutes) return;
    this.pushedMutes = key;
    this.engine.setMuteRanges(on ? muteRangesOf(this.ranges()) : []);
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private detach(): void {
    if (!this.engine) return;
    this.engine.off('timeUpdate', this.onTime);
    this.engine.off('stateChanged', this.onState);
    this.engine = null;
  }
}
