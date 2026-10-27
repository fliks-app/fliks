import { Injectable, computed, signal } from '@angular/core';

/** Return true to stay on the stack: the layer handled the gesture (stepped
 *  back one panel) but is still open. */
export type DismissCallback = () => boolean | void;

/** Stack of dismissable layers; a back gesture closes the topmost before the route-level back handler.
 * Components honour their own `closed` output when `dismissTop()` calls back; open `<dialog>`s join on their own. */
@Injectable({ providedIn: 'root' })
export class DismissableStackService {
  private readonly stack = signal<Array<DismissCallback>>([]);
  /** Layers that can vanish without a close (a dialog dropped with its page) say so here. */
  private readonly live = new WeakMap<DismissCallback, () => boolean>();

  readonly hasAny = computed(() => this.stack().length > 0);

  constructor() {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    // An open <dialog> is a layer too, in opening order: one opened over a side panel closes before it.
    const dialogs = new WeakMap<HTMLDialogElement, DismissCallback>();
    new MutationObserver((records) => {
      for (const { target } of records) {
        const d = target as HTMLDialogElement;
        const close = dialogs.get(d);
        if (d.open && !close) {
          const fn = () => d.close();
          dialogs.set(d, fn);
          this.push(fn, () => d.isConnected && d.open);
        } else if (!d.open && close) {
          dialogs.delete(d);
          this.remove(close);
        }
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });
  }

  push(close: DismissCallback, isLive?: () => boolean): void {
    if (isLive) this.live.set(close, isLive);
    this.stack.update((s) => [...s, close]);
  }

  remove(close: DismissCallback): void {
    this.stack.update((s) => s.filter((fn) => fn !== close));
  }

  /** Invokes the top close callback; false when the stack was empty. The layer is popped unless its callback returns true (consumed, e.g. a multi-step panel going back). */
  dismissTop(): boolean {
    const s = this.stack().filter((fn) => this.live.get(fn)?.() ?? true);
    if (s.length !== this.stack().length) this.stack.set(s);
    if (!s.length) return false;
    const top = s[s.length - 1];
    if (top() !== true) this.remove(top);
    return true;
  }
}
