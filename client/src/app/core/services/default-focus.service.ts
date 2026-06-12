import { Injectable, inject } from '@angular/core';
import { DeviceService } from './device.service';
import { FocusMemoryService } from './focus-memory.service';
import { NavbarService } from './navbar.service';
import { FOCUSABLE_SELECTOR } from './focusable.constants';

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

/**
 * Applies a page's default focus on arrival (Home → first library, Library →
 * first card, detail → Play button), gated to keyboard / TV input so mouse and
 * touch users never get focus stolen or a ring painted. Restores the previously
 * focused item on back-navigation. Resolution is visibility-aware: responsive
 * layouts render hidden duplicates (e.g. a mobile + desktop Play button), and
 * focusing a `display:none` one leaves the page unfocused — so we skip hidden
 * matches and fall back to the first visible focusable. The declared target
 * often renders after an async data load, so when it isn't there yet we wait
 * for it via a MutationObserver. Shared by every page via the directive.
 */
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
    return this.device.isTv() || document.body.classList.contains('keyboard-modality');
  }

  /** Focus the page's default target on arrival — the previously focused item
   *  on back-nav, else the declared first element. If the declared target isn't
   *  rendered yet (async load), wait for it. No-op for mouse / touch. */
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
    const id = active.closest<HTMLElement>(`[${t.focusIdAttr}]`)?.getAttribute(t.focusIdAttr);
    if (id) this.focusMemory.save(t.focusKey, id);
  }

  /** Register a page's default-focus target so spatial-nav can land on it when
   *  nothing is focused (e.g. first key press after a cold load, where the
   *  arrival-time pass was skipped because the user hadn't used the keyboard). */
  register(getTarget: () => DefaultFocusTarget): void {
    this.registered.add(getTarget);
  }

  unregister(getTarget: () => DefaultFocusTarget): void {
    this.registered.delete(getTarget);
  }

  /** The active page's default focusable — the only registered target whose host
   *  is still connected (cached/detached pages are skipped). Consulted by
   *  spatial-nav instead of blindly focusing the first document focusable. */
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
    const item = t.host.querySelector<HTMLElement>(`[${t.focusIdAttr}="${CSS.escape(saved)}"]`);
    return this.firstVisibleFocusable(item);
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
    if (el.matches(FOCUSABLE_SELECTOR) && this.isVisible(el)) return el;
    for (const c of Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))) {
      if (this.isVisible(c)) return c;
    }
    return null;
  }

  /** Rendered (not display:none on itself or an ancestor). */
  private isVisible(el: HTMLElement): boolean {
    return el.offsetParent !== null;
  }
}
