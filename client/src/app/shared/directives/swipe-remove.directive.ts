import { Directive, ElementRef, inject, input, output } from '@angular/core';

const THRESHOLD = 80;

/** Touch-only swipe to the left that removes the row: past the threshold the row slides out and `swiped` fires.
 *  The parent receives `--swipe` (0 to 1) to fade in a backdrop; vertical scrolling stays with the browser. */
@Directive({
  selector: '[appSwipeRemove]',
  host: {
    style: 'touch-action: pan-y',
    '(pointerdown)': 'down($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'up()',
    '(pointercancel)': 'reset()',
  },
})
export class SwipeRemoveDirective {
  readonly swiped = output<void>();
  readonly swipeDisabled = input(false);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private x0 = 0;
  private y0 = 0;
  private tracking = false;
  private active = false;
  private dx = 0;

  protected down(e: PointerEvent): void {
    this.tracking = e.pointerType === 'touch' && !this.swipeDisabled();
    this.active = false;
    this.x0 = e.clientX;
    this.y0 = e.clientY;
  }

  protected move(e: PointerEvent): void {
    if (!this.tracking) return;
    const dx = e.clientX - this.x0;
    if (!this.active) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(e.clientY - this.y0)) return;
      this.active = true;
      this.el.setPointerCapture(e.pointerId);
    }
    this.dx = Math.min(0, dx);
    this.paint(this.dx, false);
  }

  protected up(): void {
    if (!this.active) return;
    this.active = false;
    if (-this.dx < THRESHOLD) return this.reset();
    this.paint(-this.el.offsetWidth, true);
    setTimeout(() => this.swiped.emit(), 150);
  }

  protected reset(): void {
    this.tracking = this.active = false;
    this.paint(0, true);
  }

  private paint(dx: number, animate: boolean): void {
    this.el.style.transition = animate ? 'transform 0.15s ease-out' : 'none';
    this.el.style.transform = dx ? `translateX(${dx}px)` : '';
    this.el.parentElement?.style.setProperty('--swipe', String(Math.min(1, -dx / THRESHOLD)));
  }
}
