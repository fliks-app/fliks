import {
  ChangeDetectionStrategy,
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
import { TvService } from '../../../core/services/tv.service';

@Component({
  selector: 'app-seekbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './seekbar.html',
})
export class SeekbarComponent {
  private readonly tv = inject(TvService);

  readonly currentTime = input(0);
  readonly duration = input(0);
  readonly bufferedEnd = input(0);
  readonly spriteUrl = input<string | null>(null);
  readonly spriteMetadata = input<SpriteMetadata | null>(null);
  readonly variant = input<'player' | 'cast'>('player');
  readonly showTooltip = input(true);
  readonly showBuffered = input(true);
  /** Drives an indeterminate sweep across the track while the engine is
   *  fetching/buffering, so the bar reads as "working" even when the
   *  playhead isn't advancing. */
  readonly loading = input(false);
  readonly chapters = input<{ startSeconds: number; endSeconds: number; title?: string }[]>([]);
  /** Drawn as tinted bands on the unplayed track so the user can see what they
   *  are scrubbing into, ahead of the skip cue that covers the same range. */
  readonly introMarker = input<{ startSeconds: number; endSeconds: number } | null>(null);
  readonly outroMarker = input<{ startSeconds: number; endSeconds: number } | null>(null);
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

  /** Keyboard / D-pad scrub holds the preview open: there is no cursor parked
   *  on the bar to keep it alive the way a pointer drag has, so it would blink
   *  away the instant the key lifts. */
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

  /** Signed offset from the playhead while a scrub accumulates, which is what
   *  makes the accelerating step legible instead of surprising. The player
   *  freezes `currentTime` for the duration of the scrub, so this reads the
   *  whole run rather than the last press. */
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
      // Only consider the seek settled once the playhead reached the target
      // AND buffering finished. Clearing on position alone, while the engine is
      // still buffering (loading), drops the determinate fill into the
      // indeterminate sweep for a frame — the white bar flickering away right
      // as the seek lands (very visible on Tizen, where the seek re-buffers).
      if (Math.abs(this.currentTime() - this.seekTarget) < 2 && !this.loading()) {
        setTimeout(() => this.seekPending.set(false), 0);
        return this.currentTime();
      }
      return this.dragTime();
    }
    return this.currentTime();
  });

  readonly displayPercent = computed(() => {
    const d = this.duration() || 1;
    return (this.displayTime() / d) * 100;
  });

  /** Show the determinate position fill whenever the media is loaded, i.e. we
   *  have a real position to draw. Deliberately independent of `loading` and
   *  `seekPending`: a seek re-buffers and the playhead jumps to the target a
   *  frame before `loading` flips true, so any condition mixing those signals
   *  races and drops the fill for a frame between seek-end and resume — on the
   *  browser as much as on Tizen. The indeterminate sweep is reserved for the
   *  cold start (no position yet, `duration === 0`); `displayTime` still parks
   *  the fill on the seek target while buffering. */
  readonly showPositionFill = computed(() => this.duration() > 0);

  /** Track height + tint class string. Slim baseline (`h-1`),
   *  thickens to `h-2.5` during interaction:
   *  - active drag (\`dragging\`)
   *  - mouse hover (\`hovering\` signal, driven by pointermove)
   *  - keyboard / TV-remote focus (\`group-focus-visible:\`)
   *
   *  Hover is gated on the explicit signal rather than \`group-hover:\`
   *  because mobile browsers leave \`:hover\` sticky after a tap — the
   *  bar would stay thick after the user released. The signal is
   *  never set during touch drag (onProgressHover early-returns) so
   *  it cleanly reverts on touch end. The dot syntax in Tailwind
   *  utilities (\`h-1\`) can't be expressed via \`[class.h-1]\`
   *  bindings — Angular's class-toggle syntax stops at the dot — so
   *  the class list is assembled here. */
  readonly trackClass = computed(() => {
    if (this.variant() === 'cast') return 'h-1 bg-base-300';
    const thick = this.dragging() || this.hovering();
    const base = 'bg-white/20 group-focus-visible:h-2.5';
    return `${base} ${thick ? 'h-2.5' : 'h-1'}`;
  });

  /** Full class list for the indeterminate sweep overlay. The player rides on
   *  top of video (white reads on any frame); the cast card uses theme
   *  surfaces, so there the sweep tracks the foreground colour to stay visible
   *  on light + dark. Assembled here (like trackClass) so a single `[class]`
   *  binding owns the element — no static/bound merge to reason about. */
  readonly loadingSweepClass = computed(() => {
    const via = this.variant() === 'cast' ? 'via-base-content/40' : 'via-white/60';
    return `absolute inset-0 pointer-events-none bg-gradient-to-r from-transparent ${via} to-transparent animate-seekbar-indeterminate`;
  });

  // Sprite preview computeds
  private readonly previewScale = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return 1.5;
    // The 10-foot UI needs a far bigger frame, and capping width alone leaves a
    // wide film short: sprites are a fixed 240 px wide with the height taken
    // from the source aspect, so 2.40:1 is 240x100 against 16:9's 240x135.
    // Bounding the height as well lands every aspect on the same height and
    // lets the width grow instead.
    if (this.tv.isTv()) {
      return Math.min(2.5, 420 / meta.thumbWidth, 170 / meta.thumbHeight);
    }
    // Tighter cap on phones: the tooltip lives directly above the
    // seekbar, which sits directly above the mobile big buttons (rewind
    // / play / forward), and a wide thumbnail visually crowds that
    // stack on small viewports. Gate on the SHORTER viewport dimension
    // so landscape phones (e.g. S25 at 915×412) still get the small
    // cap — width alone misses them because landscape > 640 px wide.
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
    // Centre the tooltip on the seek point (the element carries
    // `-translate-x-1/2`). Plain `%` only — a CSS min()/calc() cap is ignored
    // by Tizen's older Chromium in `left`, which left the preview stuck
    // off-centre on the TV. The tooltip can overshoot the frame edges (the
    // left side already did); a CSS-only right cap needs min()/clamp().
    return `${pct}%`;
  });

  onProgressDown(event: PointerEvent) {
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
    this.seekPending.set(true);
    this.seek.emit(this.seekTarget);
  }

  private updateDragFromPointer(e: PointerEvent, bar: HTMLElement) {
    this.dragTime.set(calcDragTime(e, bar, this.duration()));
  }

  onProgressHover(event: PointerEvent) {
    if (this.dragging()) return;
    const bar = event.currentTarget as HTMLElement;
    this.hovering.set(true);
    this.hoverTime.set(calcDragTime(event, bar, this.duration()));
    this.hoverPercent.set(calcHoverPercent(event, bar));
  }

  onProgressLeave() {
    this.hovering.set(false);
  }

  /**
   * Keyboard handler — only active while the seekbar itself has focus.
   *
   * Tap ←/→: seek ±10s. Hold: enters scrub mode and accelerates the step
   * based on how long the key has been held (10s → 30s → 60s → 5min). The
   * preview tooltip follows dragTime; the player seek is deferred until the
   * user stops pressing, so a whole run is one seek and one transcode respawn.
   */
  private scrubStartedAt = 0;
  private scrubCommitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Idle gap that ends a scrub run. Long enough to tap again and keep adding
   *  to the same offset — a release used to commit at once, which reset the
   *  readout to +10 on every press and left no way to build a bigger jump.
   *  A held key repeats far faster than this, so holding is unaffected. */
  private static readonly SCRUB_IDLE_MS = 700;
  /** A scrub that lands this close to a chapter edge takes the edge instead.
   *  Only applied to the accumulated key scrub — snapping a pointer drag would
   *  fight a deliberate, precise one. */
  private static readonly CHAPTER_SNAP_S = 5;

  onKeydown(e: KeyboardEvent) {
    const dur = this.duration();
    if (!dur) return;

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

    const next = Math.max(0, Math.min(dur, this.dragTime() + direction * step));
    this.dragTime.set(next);

    this.scheduleScrubCommit();
  }

  onKeyup(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // Restart the window rather than commit: the user may still be tapping.
    this.scheduleScrubCommit();
    // A real hold auto-repeats keydown with no keyup in between, so this only
    // fires between separate taps: reset the acceleration clock here so the
    // idle gap between taps doesn't count as held time (the run/offset survive).
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

  /** Jump to the next / previous chapter start. Measured from `displayTime`,
   *  not the preview: with no scrub in flight the preview reports the pointer
   *  (0 on a remote), which would step from the head of the file. */

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
    return Math.max(0, Math.min(this.duration() || 0, best));
  }

  private commitScrub() {
    if (!this.dragging()) return;
    const target = this.snapToChapter(this.dragTime());
    this.dragTime.set(target);
    this.dragging.set(false);
    this.dragChange.emit(false);
    this.seekTarget = target;
    this.seekPending.set(true);
    this.seek.emit(target);
  }

  private commitScrubTo(target: number) {
    if (this.dragging()) {
      this.dragging.set(false);
      this.dragChange.emit(false);
    }
    this.seekTarget = target;
    this.seekPending.set(true);
    this.seek.emit(target);
  }
}
