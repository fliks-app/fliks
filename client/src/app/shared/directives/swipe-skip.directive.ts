import { Directive, ElementRef, inject, input, output } from '@angular/core';

/** Fraction of the host width past which a release skips. */
const THRESHOLD = 0.4;

/** Touch-only horizontal swipe: reports the drag as a fraction of the host width, then whether the release skips.
 *  Vertical scrolling stays with the browser; the host paints the motion. */
@Directive({
  selector: '[appSwipeSkip]',
  host: {
    style: 'touch-action: pan-y',
    '(pointerdown)': 'down($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'up()',
    '(pointercancel)': 'cancel()',
  },
})
export class SwipeSkipDirective {
  readonly dragged = output<number>();
  /** The direction to skip to, or null when the release falls back. */
  readonly released = output<'next' | 'previous' | null>();
  /** The directions with a track to skip to; the host doesn't move the other way. */
  readonly allow = input({ next: true, previous: true });
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private x0 = 0;
  private y0 = 0;
  private tracking = false;
  private active = false;
  private dx = 0;

  protected down(e: PointerEvent): void {
    this.tracking = e.pointerType === 'touch' && (this.allow().next || this.allow().previous);
    this.active = false;
    this.x0 = e.clientX;
    this.y0 = e.clientY;
  }

  protected move(e: PointerEvent): void {
    if (!this.tracking) return;
    let dx = e.clientX - this.x0;
    if ((dx < 0 && !this.allow().next) || (dx > 0 && !this.allow().previous)) dx = 0;
    if (!this.active) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(e.clientY - this.y0)) return;
      this.active = true;
      this.el.setPointerCapture(e.pointerId);
    }
    this.dx = dx;
    this.dragged.emit(dx / (this.el.offsetWidth || 1));
  }

  protected up(): void {
    if (!this.active) return void (this.tracking = false);
    const skip = Math.abs(this.dx) >= THRESHOLD * this.el.offsetWidth;
    this.tracking = this.active = false;
    this.released.emit(skip ? (this.dx < 0 ? 'next' : 'previous') : null);
  }

  protected cancel(): void {
    if (this.active) this.released.emit(null);
    this.tracking = this.active = false;
  }
}
