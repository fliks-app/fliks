import { Directive, ElementRef, inject, input, output } from '@angular/core';

/** Fraction of the host width past which a release skips. */
const THRESHOLD = 0.4;

/** Touch-only horizontal swipe: the host follows the finger, and past the threshold `skipped` fires with the direction.
 *  Vertical scrolling stays with the browser. */
@Directive({
  selector: '[appSwipeSkip]',
  host: {
    style: 'touch-action: pan-y',
    '(pointerdown)': 'down($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'up()',
    '(pointercancel)': 'reset()',
  },
})
export class SwipeSkipDirective {
  readonly skipped = output<'next' | 'previous'>();
  /** The live horizontal offset as a fraction of the host width, 0 once released. */
  readonly dragged = output<number>();
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
    this.paint(dx, false);
  }

  protected up(): void {
    const skip = this.active && Math.abs(this.dx) >= THRESHOLD * this.el.offsetWidth;
    if (skip) this.skipped.emit(this.dx < 0 ? 'next' : 'previous');
    this.reset(!skip);
  }

  protected reset(animate = true): void {
    this.tracking = this.active = false;
    this.paint(0, animate);
  }

  private paint(dx: number, animate: boolean): void {
    this.el.style.transition = animate ? 'transform 0.15s ease-out, opacity 0.15s ease-out' : 'none';
    this.el.style.transform = dx ? `translateX(${dx}px)` : '';
    this.dragged.emit(dx / (this.el.offsetWidth || 1));
  }
}
