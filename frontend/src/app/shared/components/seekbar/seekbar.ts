import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { formatTime, calcDragTime, calcHoverPercent, SpriteMetadata } from '../../../core/utils/player.utils';

@Component({
  selector: 'app-seekbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './seekbar.html',
})
export class SeekbarComponent {
  readonly currentTime = input(0);
  readonly duration = input(0);
  readonly bufferedEnd = input(0);
  readonly spriteUrl = input<string | null>(null);
  readonly spriteMetadata = input<SpriteMetadata | null>(null);
  readonly variant = input<'player' | 'cast'>('player');
  readonly showTooltip = input(true);
  readonly showThumb = input(true);
  readonly showBuffered = input(true);
  readonly chapters = input<{ startSeconds: number; endSeconds: number; title?: string }[]>([]);

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

  // Hover state
  readonly hovering = signal(false);
  readonly hoverTime = signal(0);
  readonly hoverPercent = signal(0);

  readonly formatTime = formatTime;

  /** The displayed position: dragTime during drag/seekPending, currentTime otherwise */
  readonly displayTime = computed(() => {
    if (this.dragging()) return this.dragTime();
    if (this.seekPending()) {
      if (Math.abs(this.currentTime() - this.seekTarget) < 2) {
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

  // Sprite preview computeds
  private readonly previewScale = computed(() => {
    const meta = this.spriteMetadata();
    if (!meta) return 1.5;
    const maxW = window.innerWidth < 640 ? 176 : 224;
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
    const time = this.dragging() ? this.dragTime() : this.hoverTime();
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
    const pct = this.dragging() ? this.displayPercent() : this.hoverPercent();
    const half = this.previewWidth() / 2 || 120;
    return `clamp(${half}px, ${pct}%, calc(100% - ${half}px))`;
  });

  onProgressDown(event: PointerEvent) {
    const bar = event.currentTarget as HTMLElement;
    event.preventDefault();

    try { bar.setPointerCapture(event.pointerId); } catch {}

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
   * Keyboard handler — only active while the seekbar itself has focus
   * (D-pad behavior aligned with Jellyfin: arrows only seek when "on" the
   * progress bar; otherwise they navigate between controls).
   *
   *   ←/→     ±10s
   *   Shift+← /→  ±30s
   *   Home/End    jump to start/end
   *   Space/Enter let the global player handler toggle play/pause
   */
  onKeydown(e: KeyboardEvent) {
    const dur = this.duration();
    if (!dur) return;
    let target: number | null = null;
    const step = e.shiftKey ? 30 : 10;
    switch (e.key) {
      case 'ArrowLeft':  target = this.currentTime() - step; break;
      case 'ArrowRight': target = this.currentTime() + step; break;
      case 'Home':       target = 0; break;
      case 'End':        target = Math.max(0, dur - 1); break;
    }
    if (target === null) return;
    e.preventDefault();
    e.stopPropagation();
    target = Math.max(0, Math.min(target, dur));
    this.seek.emit(target);
  }
}
