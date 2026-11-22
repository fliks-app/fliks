import { signal } from '@angular/core';

/** Pull-down-to-dismiss gesture of a bottom sheet, shared by `app-bottom-sheet` and the phone `<dialog>` sheets. */
export class SheetDrag {
  readonly dragging = signal(false);
  readonly offset = signal(0);
  private startX = 0;
  private startY = 0;
  /** Only a touch that began with the sheet scrolled to the top can dismiss, so a scroll never chains into the close. */
  private startedAtTop = false;
  /** A drag from the handle/title always dismisses: it sits above the list, so it never scrolls it. */
  private fromHandle = false;
  /** Y of the previous touchmove and the last move's direction; release dismisses only if still heading down. */
  private prevY = 0;
  private movingDown = true;

  start(e: TouchEvent, sheet: HTMLElement, fromHandle: boolean): void {
    this.startX = e.touches[0].clientX;
    this.startY = e.touches[0].clientY;
    this.prevY = this.startY;
    this.movingDown = true;
    this.startedAtTop = !scrolledBetween(e.target, sheet);
    this.fromHandle = fromHandle;
    // A slider or a list drag handle owns its gesture and must never pull the sheet down.
    if (e.target instanceof Element && e.target.closest('input[type="range"], [cdkDragHandle]')) {
      this.startedAtTop = false;
      this.fromHandle = false;
    }
  }

  move(e: TouchEvent, sheet: HTMLElement): void {
    const y = e.touches[0].clientY;
    const deltaY = y - this.startY;
    // A mostly horizontal move (a row swipe) is not a dismiss drag.
    if (!this.dragging() && Math.abs(e.touches[0].clientX - this.startX) > Math.abs(deltaY)) return;

    const canDrag = this.fromHandle || (this.startedAtTop && !scrolledBetween(e.target, sheet));
    if (canDrag && deltaY > 0) {
      e.preventDefault();
      this.dragging.set(true);
      this.offset.set(deltaY);
      // 2px deadzone ignores jitter, so the release can tell an eased-back pull from a committed swipe.
      const dy = y - this.prevY;
      if (Math.abs(dy) >= 2) this.movingDown = dy > 0;
    } else if (this.dragging() && deltaY <= 0) {
      this.reset();
    }
    this.prevY = y;
  }

  /** Ends the gesture; true when it should dismiss: pulled past the threshold and still heading down. */
  end(): boolean {
    if (!this.dragging()) return false;
    this.dragging.set(false);
    if (this.offset() > 80 && this.movingDown) return true;
    this.offset.set(0);
    return false;
  }

  reset(): void {
    this.dragging.set(false);
    this.offset.set(0);
  }
}

/** Whether anything from the touched element up to the sheet is scrolled away
 *  from its top: content may scroll in an inner box (a list under a sticky title). */
export function scrolledBetween(target: EventTarget | null, sheet: HTMLElement): boolean {
  for (let n = target instanceof Element ? target : null; n; n = n.parentElement) {
    if (n.scrollTop > 0) return true;
    if (n === sheet) return false;
  }
  return false;
}

/** `--transition-duration-sheet` in ms, as resolved on `el`; the minifier may rewrite `180ms` as `.18s`. */
export function sheetDurationMs(el: Element): number {
  const v = getComputedStyle(el).getPropertyValue('--transition-duration-sheet').trim();
  return (parseFloat(v) || 0) * (v.endsWith('ms') ? 1 : 1000);
}
