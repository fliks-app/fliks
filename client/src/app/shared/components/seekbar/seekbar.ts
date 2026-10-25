import {
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { formatTime, calcDragTime, calcHoverPercent, SpriteMetadata } from '../../../core/utils/player.utils';
import { muteRangesOf, type EdlRange } from '../../../core/utils/edl-policy';
import { TvService } from '../../../core/services/tv.service';

/** How long the bar waits for a seek to land before following the
 *  playhead again, whatever the player decided to do with it. */
const SEEK_SETTLE_TIMEOUT_MS = 4000;

@Component({
  selector: 'app-seekbar',
  templateUrl: './seekbar.html',
})
export class SeekbarComponent {
  private readonly tv = inject(TvService);

  readonly currentTime = input(0);
  readonly duration = input(0);
  readonly bufferedEnd = input(0);
  /** The span a seek can land in. Both default to the whole bar; a live stream
   *  narrows them, having neither the rolled-out past nor the unaired future. */
  readonly seekableStart = input(0);
  readonly seekableEnd = input(0);
  readonly spriteUrl = input<string | null>(null);
  readonly spriteMetadata = input<SpriteMetadata | null>(null);
  readonly variant = input<'player' | 'cast'>('player');
  /** Shows progress only: no scrub, seek or hover preview. */
  readonly disabled = input(false);
  readonly showTooltip = input(true);
  readonly showBuffered = input(true);
  /** Indeterminate sweep while the engine buffers, so the bar reads as working even when the playhead is still. */
  readonly loading = input(false);
  readonly chapters = input<{ startSeconds: number; endSeconds: number; title?: string }[]>([]);
  /** Drawn as tinted bands on the unplayed track so the user can see what they
   *  are scrubbing into, ahead of the skip cue that covers the same range. */
  readonly introMarker = input<{ startSeconds: number; endSeconds: number } | null>(null);
  readonly outroMarker = input<{ startSeconds: number; endSeconds: number } | null>(null);
  /** EDL ranges drawn over the track: cuts and commercials as bands, mutes as one thin strip. */
  readonly edlRanges = input<readonly EdlRange[]>([]);
  /** Chapter start times as % of duration for seekbar tick rendering. */
  readonly chapterTicks = computed(() => {
    const dur = this.duration() || 0;
    if (dur <= 0) return [];
    return this.chapters()
      .map((c) => ({ percent: (c.startSeconds / dur) * 100, title: c.title }))
      .filter((t) => t.percent > 0.5 && t.percent < 99.5);
  });

  readonly seek = output<number>();
  readonly dragChange = output<boolean>();

  // Drag state
  readonly dragging = signal(false);
  readonly dragTime = signal(0);
  readonly seekPending = signal(false);
  private seekTarget = 0;
  /** A live player may clamp a seek outside its window, so the playhead never reaches the target; this bounds the wait. */
  private seekDeadline = 0;

  /** Keeps the preview open after a key scrub: no parked cursor keeps it alive as in a pointer drag. */
  readonly keyScrubbing = signal(false);
  private keyPreviewTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly KEY_PREVIEW_LINGER_MS = 2200;

  /** Tooltip (time + sprite frame) is up while the user points at the bar,
   *  drags it, or has just scrubbed it with the keyboard. */
  readonly previewVisible = computed(
    () => this.hovering() || this.dragging() || this.keyScrubbing(),
  );

  /** The instant the preview describes: the drag target while scrubbing, the
   *  committed target while the seek settles, the pointer otherwise. */
  readonly previewTime = computed(() => {
    if (this.dragging()) return this.dragTime();
    if (this.keyScrubbing()) return this.displayTime();
    return this.hoverTime();
  });

  /** Title of the chapter the preview sits in. The single biggest readability
   *  win on a long file — a timecode alone says nothing about where you are. */
  readonly previewChapter = computed(() => {
    const t = this.previewTime();
    return (
      this.chapters().find((c) => t >= c.startSeconds && t < c.endSeconds)
        ?.title ?? null
    );
  });

  /** Signed offset from the playhead during a scrub; the player freezes `currentTime`, so this reads the whole run. */
  readonly previewDelta = computed(() => {
    if (!this.dragging() && !this.keyScrubbing()) return 0;
    return Math.round(this.previewTime() - this.currentTime());
  });

  /** Intro / outro ranges as track percentages. */
  readonly markerBands = computed(() => {
    const dur = this.duration() || 0;
    if (dur <= 0) return [];
    const marks = [
      { kind: 'intro', m: this.introMarker() },
      { kind: 'outro', m: this.outroMarker() },
    ];
    return marks.flatMap(({ kind, m }) => {
      if (!m || m.endSeconds <= m.startSeconds) return [];
      return [
        {
          kind,
          left: (m.startSeconds / dur) * 100,
          width: ((m.endSeconds - m.startSeconds) / dur) * 100,
        },
      ];
    });
  });

  /** Cut and commercial ranges as track percentages. */
  readonly edlBands = computed(() => {
    const dur = this.duration() || 0;
    if (dur <= 0) return [];
    return this.edlRanges()
      .filter((r) => r.action !== 'mute' && r.end > r.start && r.start < dur && r.end > 0)
      .map((r) => {
        const left = (Math.max(0, r.start) / dur) * 100;
        const right = (Math.min(r.end, dur) / dur) * 100;
        return { kind: r.action, left, width: Math.min(100 - left, Math.max(0.1, right - left)) };
      });
  });

  /** Every mute range in a single gradient: one element however many ranges there are. */
  readonly muteStrip = computed(() => {
    const dur = this.duration() || 0;
    if (dur <= 0) return null;
    const stops: string[] = [];
    let pos = 0;
    for (const r of muteRangesOf(this.edlRanges())) {
      const a = Math.max(pos, (r.start / dur) * 100);
      const b = Math.min(100, Math.max(a + 0.1, (r.end / dur) * 100));
      if (a >= 100) break;
      stops.push(`transparent ${pos}% ${a}%`, `var(--color-accent) ${a}% ${b}%`);
      pos = b;
    }
    return stops.length ? `linear-gradient(to right, ${stops.join(', ')}, transparent ${pos}%)` : null;
  });

  // Hover state
  readonly hovering = signal(false);
  readonly hoverTime = signal(0);
  readonly hoverPercent = signal(0);

  /** The focusable track element (role=slider). */
  private readonly trackRoot = viewChild<ElementRef<HTMLElement>>('trackRoot');

  /** Focus the seekbar track. Used when an arrow press wakes hidden controls so
   *  subsequent D-pad presses scrub here instead of nudging another control. */
  focus(): void {
    this.trackRoot()?.nativeElement.focus();
  }

  readonly formatTime = formatTime;

  /** `+1:30` / `-0:20` — the offset, not a timestamp. */
  formatDelta(seconds: number): string {
    return `${seconds < 0 ? '-' : '+'}${formatTime(Math.abs(seconds))}`;
  }

  /** The displayed position: dragTime during drag/seekPending, currentTime otherwise */
  readonly displayTime = computed(() => {
    if (this.dragging()) return this.dragTime();
    if (this.seekPending()) {
      // Settled only once the playhead reached the target AND buffering ended, or the fill flickers into the sweep (Tizen re-buffers on seek).
      const landed = Math.abs(this.currentTime() - this.seekTarget) < 2 && !this.loading();
      if (landed || Date.now() > this.seekDeadline) {
        setTimeout(() => this.seekPending.set(false), 0);
        return this.currentTime();
      }
      return this.dragTime();
    }
    return this.currentTime();
  });

  /** Left share of the bar that has rolled out of reach, as a percentage. */
  readonly unreachablePercent = computed(() => {
    const d = this.duration() || 0;
    if (!d || this.seekableStart() <= 0) return 0;
    return Math.min(100, (this.seekableStart() / d) * 100);
  });

  /** Right share of the bar that has not aired yet, as a percentage. */
  readonly unairedPercent = computed(() => {
    const d = this.duration() || 0;
    const end = this.seekableEnd();
    if (!d || end <= 0 || end >= d) return 0;
    return Math.min(100, ((d - end) / d) * 100);
  });

  /** A live bar offers only a slice of its span: stop at the edges instead of requesting a refused seek. Inert on VOD. */
  private clampToSeekable(seconds: number): number {
    const d = this.duration() || 0;
    const end = this.seekableEnd() > 0 ? Math.min(this.seekableEnd(), d) : d;
    const start = Math.min(Math.max(0, this.seekableStart()), end);
    return Math.max(start, Math.min(end, seconds));
  }

  private armSeekPending(): void {
    this.seekPending.set(true);
    this.seekDeadline = Date.now() + SEEK_SETTLE_TIMEOUT_MS;
  }

  readonly displayPercent = computed(() => {
    const d = this.duration() || 1;
    return (this.displayTime() / d) * 100;
  });

  /** Position fill whenever media is loaded. Independent of `loading`/`seekPending`: mixing them races and drops the fill between seek end and resume. */
  readonly showPositionFill = computed(() => this.duration() > 0);

  /** Track height + tint: `h-1` baseline, `h-2.5` while dragging, hovering or focused. Hover uses a signal, not `group-hover:`
   *  (sticky after a tap on mobile); classes are built here since `[class.h-1]` can't express a dot. */
  readonly trackClass = computed(() => {
    if (this.variant() === 'cast') return 'h-1 bg-base-300';
    const thick = this.dragging() || this.hovering();
    const base = 'bg-white/20 group-focus-visible:h-2.5';
    return `${base} ${thick ? 'h-2.5' : 'h-1'}`;
  });

  /** Sweep overlay classes: white over video in the player, foreground colour on theme surfaces in the cast card. */
  readonly loadingSweepClass = computed(() => {
    const via = this.variant() === 'cast' ? 'via-base-content/40' : 'via-white/60';
    return `absolute inset-0 pointer-events-none bg-gradient-to-r from-transparent ${via} to-transparent animate-seekbar-indeterminate`;
  });

  // Sprite preview computeds
  private readonly previewScale = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return 1.5;
    // 10-foot UI: bound the height as well as the width, or a wide film (2.40:1 sprites are 240x100) stays short.
    if (this.tv.isTv()) {
      return Math.min(2.5, 420 / meta.thumbWidth, 170 / meta.thumbHeight);
    }
    // Tighter cap on phones so the tooltip doesn't crowd the big buttons below; shorter viewport side so landscape phones (>640 wide) still match.
    const shortSide = Math.min(window.innerWidth, window.innerHeight);
    const maxW = shortSide < 640 ? 144 : 224;
    return Math.min(1.5, maxW / meta.thumbWidth);
  });

  protected readonly previewWidth = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return 0;
    return meta.thumbWidth * this.previewScale();
  });

  protected readonly previewHeight = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return 0;
    return meta.thumbHeight * this.previewScale();
  });

  readonly thumbnailBgPositionScaled = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return '0 0';
    const s = this.previewScale();
    const time = this.previewTime();
    const index = Math.min(Math.floor(time / meta.interval), meta.count - 1);
    const col = index % meta.columns;
    const row = Math.floor(index / meta.columns);
    return `-${col * meta.thumbWidth * s}px -${row * meta.thumbHeight * s}px`;
  });

  readonly spriteBgSizeScaled = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return 'auto';
    const s = this.previewScale();
    const rows = Math.ceil(meta.count / meta.columns);
    return `${meta.columns * meta.thumbWidth * s}px ${rows * meta.thumbHeight * s}px`;
  });

  readonly tooltipLeft = computed(() => {
    const pct = this.dragging() || this.keyScrubbing() ? this.displayPercent() : this.hoverPercent();
    // Plain `%` only: Tizen's older Chromium ignores a CSS min()/calc() cap in `left`, leaving the preview off-centre.
    return `${pct}%`;
  });

  onProgressDown(event: PointerEvent) {
    if (this.disabled()) return;
    const bar = event.currentTarget as HTMLElement;
    event.preventDefault();

    try { bar.setPointerCapture(event.pointerId); } catch {}

    this.endKeyPreview();
    // A pending key-scrub commit must not fire mid-drag and snap the thumb to
    // wherever the pointer happened to be when its 700ms window elapsed.
    this.cancelScrubTimer();
    this.dragging.set(true);
    this.dragChange.emit(true);
    this.updateDragFromPointer(event, bar);

    const onMove = (e: PointerEvent) => {
      this.updateDragFromPointer(e, bar);
    };

    const cleanup = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onEnd);
      bar.removeEventListener('pointercancel', onEnd);
      document.removeEventListener('pointermove', onMoveDoc);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      document.documentElement.style.removeProperty('touch-action');
    };

    const onEnd = () => {
      cleanup();
      this.finishDrag();
    };

    const onMoveDoc = (e: PointerEvent) => {
      this.updateDragFromPointer(e, bar);
    };

    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onEnd);
    bar.addEventListener('pointercancel', onEnd);
    document.addEventListener('pointermove', onMoveDoc);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);

    document.documentElement.style.setProperty('touch-action', 'none');
  }

  private finishDrag() {
    if (!this.dragging()) return;
    this.dragging.set(false);
    this.dragChange.emit(false);
    this.seekTarget = this.dragTime();
    this.armSeekPending();
    this.seek.emit(this.seekTarget);
  }

  private updateDragFromPointer(e: PointerEvent, bar: HTMLElement) {
    this.dragTime.set(this.clampToSeekable(calcDragTime(e, bar, this.duration())));
  }

  onProgressHover(event: PointerEvent) {
    if (this.disabled() || this.dragging()) return;
    const bar = event.currentTarget as HTMLElement;
    this.hovering.set(true);
    const hover = this.clampToSeekable(calcDragTime(event, bar, this.duration()));
    this.hoverTime.set(hover);
    // Position the preview from the clamped time, so it stops at either edge
    // instead of drifting on past it with a frozen readout.
    const d = this.duration() || 0;
    this.hoverPercent.set(d ? (hover / d) * 100 : calcHoverPercent(event, bar));
  }

  onProgressLeave() {
    this.hovering.set(false);
  }

  /** Key handler: tap seeks +-10s, hold scrubs with growing steps; the seek is deferred until the key stops, so a run is one seek. */
  private scrubStartedAt = 0;
  private scrubCommitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Idle gap that ends a scrub run: long enough to tap again and keep adding; a held key repeats faster. */
  private static readonly SCRUB_IDLE_MS = 700;
  /** A key scrub landing this close to a chapter edge takes the edge; not applied to pointer drags (would fight precision). */
  private static readonly CHAPTER_SNAP_S = 5;

  onKeydown(e: KeyboardEvent) {
    const dur = this.duration();
    if (!dur || this.disabled()) return;

    let direction = 0;
    switch (e.key) {
      case 'ArrowLeft':  direction = -1; break;
      case 'ArrowRight': direction = 1; break;
      case 'Home':
        e.preventDefault();
        e.stopPropagation();
        this.cancelScrubTimer();
        this.holdKeyPreview();
        this.commitScrubTo(0);
        return;
      case 'End':
        e.preventDefault();
        e.stopPropagation();
        this.cancelScrubTimer();
        this.holdKeyPreview();
        this.commitScrubTo(Math.max(0, dur - 1));
        return;
      default:
        return;
    }

    e.preventDefault();
    e.stopPropagation();
    this.holdKeyPreview();

    if (!this.dragging()) {
      this.scrubStartedAt = Date.now();
      this.dragTime.set(this.currentTime());
      this.dragging.set(true);
      this.dragChange.emit(true);
    }

    const heldMs = Date.now() - this.scrubStartedAt;
    const step =
      heldMs < 1500 ? 10 :
      heldMs < 4000 ? 30 :
      heldMs < 8000 ? 60 : 300;

    const next = this.clampToSeekable(this.dragTime() + direction * step);
    this.dragTime.set(next);

    this.scheduleScrubCommit();
  }

  onKeyup(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // Restart the window rather than commit: the user may still be tapping.
    this.scheduleScrubCommit();
    // Taps are separate keydowns: reset the acceleration clock so the idle gap isn't counted as held time.
    this.scrubStartedAt = Date.now();
  }

  private scheduleScrubCommit() {
    this.cancelScrubTimer();
    this.scrubCommitTimer = setTimeout(() => {
      this.scrubCommitTimer = null;
      this.commitScrub();
    }, SeekbarComponent.SCRUB_IDLE_MS);
  }

  /** Restart the linger on every press, so a run of arrows keeps one preview up. */
  private holdKeyPreview() {
    this.keyScrubbing.set(true);
    if (this.keyPreviewTimer) clearTimeout(this.keyPreviewTimer);
    this.keyPreviewTimer = setTimeout(
      () => this.endKeyPreview(),
      SeekbarComponent.KEY_PREVIEW_LINGER_MS,
    );
  }

  private endKeyPreview() {
    if (this.keyPreviewTimer) clearTimeout(this.keyPreviewTimer);
    this.keyPreviewTimer = null;
    this.keyScrubbing.set(false);
  }

  private cancelScrubTimer() {
    if (this.scrubCommitTimer) {
      clearTimeout(this.scrubCommitTimer);
      this.scrubCommitTimer = null;
    }
  }

  /** Next/previous chapter start, measured from `displayTime`: with no scrub the preview reads the pointer (0 on a remote). */

  private snapToChapter(target: number): number {
    let best = target;
    let bestDist = SeekbarComponent.CHAPTER_SNAP_S;
    for (const c of this.chapters()) {
      for (const edge of [c.startSeconds, c.endSeconds]) {
        const dist = Math.abs(edge - target);
        if (dist < bestDist) {
          bestDist = dist;
          best = edge;
        }
      }
    }
    return this.clampToSeekable(best);
  }

  private commitScrub() {
    if (!this.dragging()) return;
    const target = this.snapToChapter(this.dragTime());
    this.dragTime.set(target);
    this.dragging.set(false);
    this.dragChange.emit(false);
    this.seekTarget = target;
    this.armSeekPending();
    this.seek.emit(target);
  }

  private commitScrubTo(rawTarget: number) {
    const target = this.clampToSeekable(rawTarget);
    if (this.dragging()) {
      this.dragging.set(false);
      this.dragChange.emit(false);
    }
    this.seekTarget = target;
    this.armSeekPending();
    this.seek.emit(target);
  }
}
