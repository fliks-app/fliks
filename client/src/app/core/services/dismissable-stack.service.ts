import { Injectable, computed, signal } from '@angular/core';

/** Return true to stay on the stack: the layer handled the gesture (stepped
 *  back one panel) but is still open. */
export type DismissCallback = () => boolean | void;

/**
 * Stack of dismissable layers (bottom sheets, modals, dropdowns…) so that
 * a hardware/gesture back gesture closes the topmost one before falling
 * through to the route-level back handler. Each layer registers a close
 * callback on mount and removes it on close/unmount.
 *
 * The component is responsible for honoring its own `closed` output when
 * `dismissTop()` invokes the callback — the service doesn't manipulate
 * any DOM directly.
 */
@Injectable({ providedIn: 'root' })
export class DismissableStackService {
  private readonly stack = signal<Array<DismissCallback>>([]);

  readonly hasAny = computed(() => this.stack().length > 0);

  push(close: DismissCallback): void {
    this.stack.update((s) => [...s, close]);
  }

  remove(close: DismissCallback): void {
    this.stack.update((s) => s.filter((fn) => fn !== close));
  }

  /** Invoke the top close callback. Returns true if a layer handled the
   *  gesture; false when the stack was empty (caller should fall through to
   *  route-level back). The layer is popped unless its callback returns true,
   *  which means it consumed the gesture and is still open — a multi-step
   *  panel stepping back to its parent. */
  dismissTop(): boolean {
    const s = this.stack();
    if (!s.length) return false;
    const top = s[s.length - 1];
    if (top() !== true) this.remove(top);
    return true;
  }
}
