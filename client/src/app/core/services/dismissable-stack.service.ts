import { Injectable, computed, signal } from '@angular/core';

/** Return true to stay on the stack: the layer handled the gesture (stepped
 *  back one panel) but is still open. */
export type DismissCallback = () => boolean | void;

/** Stack of dismissable layers; a back gesture closes the topmost before the route-level back handler.
 * Components honour their own `closed` output when `dismissTop()` calls back; the service touches no DOM. */
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

  /** Invokes the top close callback; false when the stack was empty. The layer is popped unless its callback returns true (consumed, e.g. a multi-step panel going back). */
  dismissTop(): boolean {
    const s = this.stack();
    if (!s.length) return false;
    const top = s[s.length - 1];
    if (top() !== true) this.remove(top);
    return true;
  }
}
