import { Injectable, inject } from '@angular/core';
import { DeviceService } from './device.service';
import { FocusMemoryService } from './focus-memory.service';
import { NavbarService } from './navbar.service';
import { FOCUSABLE_SELECTOR, isFocusCandidate } from './focusable.constants';

/** How long to wait for an async-loaded target to render before giving up and
 *  focusing whatever's there (so a slow/empty list doesn't sit unfocused). */
const WAIT_FOR_TARGET_MS = 4000;

/** A page's default-focus declaration, supplied by the appDefaultFocus directive. */
export interface DefaultFocusTarget {
  /** The directive host (search root for the default target + memory restore). */
  host: HTMLElement;
  /** CSS selector (within host) of the first element to focus; '' → first focusable. */
  selector: string;
  /** Focus-memory key for back-nav restore; '' → no memory. */
  focusKey: string;
  /** Data-attribute identifying restorable items (e.g. 'data-home-focus'). */
  focusIdAttr: string;
}

/** Applies a page's default focus on arrival (keyboard/TV only) and restores the prior focus on back-nav. Skips `display:none` duplicates,
 *  falling back to the first visible focusable, and waits via MutationObserver for targets rendered after async loads. */
@Injectable({ providedIn: 'root' })
export class DefaultFocusService {
  private readonly device = inject(DeviceService);
  private readonly focusMemory = inject(FocusMemoryService);
  private readonly navbar = inject(NavbarService);

  private pendingObserver: MutationObserver | null = null;
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly registered = new Set<() => DefaultFocusTarget>();

  /** True when the user is on a keyboard / D-pad — the only case where we steal
   *  focus on arrival (and where the ring is shown, gated identically in CSS). */
  private shouldAutoFocus(): boolean {
    if (typeof document === 'undefined') return false;
    return (
      this.device.isTv() ||
      document.documentElement.classList.contains('keyboard-modality')
    );
  }

  /** Focus the default target on arrival (previous item on back-nav, else the declared one), waiting if not rendered yet. No-op for mouse/touch. */
  applyOnArrival(t: DefaultFocusTarget): void {
    this.stopWaiting();
    if (!this.shouldAutoFocus()) return;
    const target = this.resolveTarget(t);
    if (target) {
      target.focus({ preventScroll: false });
      return;
    }
    // A declared selector that doesn't match anything visible yet means the
    // content is still loading — wait rather than grabbing a stray focusable.
    if (t.selector) this.waitForTarget(t);
  }

  /** Remember the focused item (while it's still in the host) so a later
   *  back-navigation can return to it. Called on NavigationStart. */
  saveFocus(t: DefaultFocusTarget): void {
    if (!t.focusKey || typeof document === 'undefined') return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || !t.host.contains(active)) return;
    const item = active.closest<HTMLElement>(`[${t.focusIdAttr}]`);
    const id = item?.getAttribute(t.focusIdAttr);
    if (!item || !id) return;
    this.focusMemory.save(t.focusKey, id, this.itemsWithId(t, id).indexOf(item));
  }

  /** Register a default-focus target so spatial-nav can land on it when nothing is focused (e.g. first key press after a cold load). */
  register(getTarget: () => DefaultFocusTarget): void {
    this.registered.add(getTarget);
  }

  unregister(getTarget: () => DefaultFocusTarget): void {
    this.registered.delete(getTarget);
  }

  /** The active page's default focusable: the registered target whose host is still connected (detached pages are skipped). */
  currentTarget(): HTMLElement | null {
    for (const get of this.registered) {
      const t = get();
      if (!t.host.isConnected) continue;
      const declared = t.selector ? this.firstVisibleMatch(t.host, t.selector) : null;
      return declared ?? this.firstVisibleFocusable(t.host);
    }
    return null;
  }

  /** The element to focus right now, or null if the declared target isn't ready. */
  private resolveTarget(t: DefaultFocusTarget): HTMLElement | null {
    const restored = this.tryRestore(t);
    if (restored) return restored;
    if (t.selector) return this.firstVisibleMatch(t.host, t.selector);
    return this.firstVisibleFocusable(t.host);
  }

  private waitForTarget(t: DefaultFocusTarget): void {
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => {
      if (!this.shouldAutoFocus()) {
        this.stopWaiting();
        return;
      }
      const target = this.resolveTarget(t);
      if (target) {
        target.focus({ preventScroll: false });
        this.stopWaiting();
      }
    });
    this.pendingObserver = obs;
    obs.observe(t.host, { childList: true, subtree: true });
    // Give up after a window: focus the first visible focusable so the page is
    // never left unfocused if the declared target never renders (empty list).
    this.pendingTimeout = setTimeout(() => {
      this.stopWaiting();
      if (this.shouldAutoFocus()) {
        this.firstVisibleFocusable(t.host)?.focus({ preventScroll: false });
      }
    }, WAIT_FOR_TARGET_MS);
  }

  private stopWaiting(): void {
    this.pendingObserver?.disconnect();
    this.pendingObserver = null;
    if (this.pendingTimeout !== null) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
  }

  private tryRestore(t: DefaultFocusTarget): HTMLElement | null {
    if (!t.focusKey || !this.navbar.lastWasBack()) return null;
    const saved = this.focusMemory.retrieve(t.focusKey);
    if (!saved) return null;
    const items = this.itemsWithId(t, saved.id);
    return this.firstVisibleFocusable(items[saved.nth] ?? items[0] ?? null);
  }

  private itemsWithId(t: DefaultFocusTarget, id: string): HTMLElement[] {
    return Array.from(t.host.querySelectorAll<HTMLElement>(`[${t.focusIdAttr}="${CSS.escape(id)}"]`));
  }

  /** First selector match (in DOM order) that yields a visible focusable —
   *  skips hidden responsive duplicates. */
  private firstVisibleMatch(host: HTMLElement, selector: string): HTMLElement | null {
    for (const el of Array.from(host.querySelectorAll<HTMLElement>(selector))) {
      const focusable = this.firstVisibleFocusable(el);
      if (focusable) return focusable;
    }
    return null;
  }

  /** `el` itself if it's a visible focusable, else its first visible focusable
   *  descendant. Null when nothing visible is focusable. */
  private firstVisibleFocusable(el: HTMLElement | null): HTMLElement | null {
    if (!el) return null;
    if (el.matches(FOCUSABLE_SELECTOR) && isFocusCandidate(el)) return el;
    for (const c of Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))) {
      if (isFocusCandidate(c)) return c;
    }
    return null;
  }

}
