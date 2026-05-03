import { Injectable, computed, signal } from '@angular/core';

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
  private readonly stack = signal<Array<() => void>>([]);

  readonly hasAny = computed(() => this.stack().length > 0);

  push(close: () => void): void {
    this.stack.update((s) => [...s, close]);
  }

  remove(close: () => void): void {
    this.stack.update((s) => s.filter((fn) => fn !== close));
  }

  /** Pop and invoke the top close callback. Returns true if a layer was
   *  dismissed; false when the stack was empty (caller should fall through
   *  to route-level back). */
  dismissTop(): boolean {
    const s = this.stack();
    if (!s.length) return false;
    const top = s[s.length - 1];
    this.stack.update((cur) => cur.slice(0, -1));
    top();
    return true;
  }
}
