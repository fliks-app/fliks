import type { Signal, WritableSignal } from '@angular/core';
import { clampPan, stepToward, type Pan } from '../../comic-layout';

const TAP_PX = 8;
const DOUBLE_TAP_MS = 280;
const SWIPE_PX = 50;
const WHEEL_TURN_MS = 350;
const DOUBLE_TAP_SCALE = 2.5;

/** What the gestures act on: the paged view's zoom and pan, page turns and the reader's bars. */
export interface ComicGestureTarget {
  scale: Signal<number>;
  pan: WritableSignal<Pan>;
  view: Signal<{ w: number; h: number }>;
  rtl: Signal<boolean>;
  webtoon: Signal<boolean>;
  stage(): HTMLElement;
  zoomTo(next: number, anchor: Pan): void;
  zoomBy(dir: 1 | -1): void;
  resetZoom(): void;
  /** `dir` follows the reading order. */
  step(dir: 1 | -1): void;
  toggleChrome(): void;
}

/** Pointer and wheel input on a comic: pinch and pan a zoomed page, swipe or tap a side to turn, tap the middle for the bars. */
export class ComicGestures {
  private readonly pointers = new Map<number, Pan & { x0: number; y0: number }>();
  private pinch: { dist: number; scale: number } | null = null;
  private moved = 0;
  private lastTap = { t: 0, x: 0, y: 0 };
  private tapTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWheelTurn = 0;

  constructor(private readonly t: ComicGestureTarget) {}

  dispose(): void {
    if (this.tapTimer) clearTimeout(this.tapTimer);
  }

  /** Pointer position from the stage centre, the origin the scale and pan are taken from. */
  private fromCentre(x: number, y: number): Pan {
    const r = this.t.stage().getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  }

  down(e: PointerEvent): void {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (this.pointers.size === 1) this.moved = 0;
    if (this.pointers.size === 2) {
      this.moved = Infinity;
      this.pinch = { dist: this.pointerDistance(), scale: this.t.scale() };
    }
  }

  move(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    this.moved = Math.max(this.moved, Math.hypot(p.x - p.x0, p.y - p.y0));
    if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      this.t.zoomTo(this.pinch.scale * (this.pointerDistance() / this.pinch.dist), this.fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2));
    } else if (this.t.scale() > 1) {
      this.t.pan.set(clampPan({ x: this.t.pan().x + dx, y: this.t.pan().y + dy }, this.t.scale(), this.t.view()));
    }
  }

  up(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!p || this.pointers.size) return;
    const dx = p.x - p.x0;
    const dy = p.y - p.y0;
    if (this.moved < TAP_PX) this.tap(e.clientX, e.clientY);
    else if (this.t.scale() === 1 && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy)) {
      this.t.step(stepToward(dx < 0 ? 'right' : 'left', this.t.rtl()));
    }
  }

  cancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.pinch = null;
  }

  private pointerDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  }

  /** A second tap close to the first zooms; a lone one waits out the double-tap window before it acts. */
  private tap(x: number, y: number): void {
    const now = Date.now();
    const twice = now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 30;
    this.lastTap = { t: twice ? 0 : now, x, y };
    if (this.tapTimer) clearTimeout(this.tapTimer);
    if (twice) {
      this.tapTimer = null;
      if (this.t.scale() > 1) this.t.resetZoom();
      else this.t.zoomTo(DOUBLE_TAP_SCALE, this.fromCentre(x, y));
      return;
    }
    this.tapTimer = setTimeout(() => this.tapZone(x), DOUBLE_TAP_MS);
  }

  private tapZone(x: number): void {
    const r = this.t.stage().getBoundingClientRect();
    const f = (x - r.left) / r.width;
    if (this.t.scale() > 1 || (f >= 1 / 3 && f <= 2 / 3)) this.t.toggleChrome();
    else this.t.step(stepToward(f < 0.5 ? 'left' : 'right', this.t.rtl()));
  }

  wheel(e: WheelEvent): void {
    if (this.t.webtoon()) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.t.zoomBy(e.deltaY < 0 ? 1 : -1);
      return;
    }
    e.preventDefault();
    if (e.ctrlKey) {
      this.t.zoomTo(this.t.scale() * Math.exp(-e.deltaY * 0.01), this.fromCentre(e.clientX, e.clientY));
    } else if (this.t.scale() > 1) {
      this.t.pan.set(clampPan({ x: this.t.pan().x - e.deltaX, y: this.t.pan().y - e.deltaY }, this.t.scale(), this.t.view()));
    } else if (Math.abs(e.deltaY) > 20 && Date.now() - this.lastWheelTurn > WHEEL_TURN_MS) {
      this.lastWheelTurn = Date.now();
      this.t.step(e.deltaY > 0 ? 1 : -1);
    }
  }
}
