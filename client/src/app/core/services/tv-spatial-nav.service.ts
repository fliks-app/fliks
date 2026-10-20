import { Injectable, inject, DestroyRef } from '@angular/core';
import { TvService } from './tv.service';
import { DefaultFocusService } from './default-focus.service';
import {
  FOCUSABLE_SELECTOR,
  SCROLLER_SELECTOR,
  isFocusCandidate,
  isRendered,
} from './focusable.constants';

/** Spatial navigation for D-pad and keyboard arrows: container tree (`[appTvSection]`/`[appTvRow]`) first,
 *  rect fallback outside any container. Keys are caught in capture phase to pre-empt native consumers. */

interface ContainerNode {
  readonly el: HTMLElement;
  readonly orientation: 'vertical' | 'horizontal';
  readonly isWrapping: boolean;
  parent: ContainerNode | null;
  /** Last focusable that received focus inside this container (or any
   * descendant). Used to dig down on re-entry. */
  activeChild: HTMLElement | null;
}

/** Page scroll step (px) when an up/down move has no focusable neighbour — lets
 *  the user reach non-focusable info content below the last card. */
const PAGE_SCROLL_AMOUNT_PX = 300;

/** Held-key pacing: auto-repeat outruns smooth scrolls and judders. Taps are never paced. */
const REPEAT_MIN_INTERVAL_MS = 200;

@Injectable({ providedIn: 'root' })
export class TvSpatialNavService {
  private readonly tv = inject(TvService);
  private readonly defaultFocus = inject(DefaultFocusService);
  private readonly destroyRef = inject(DestroyRef);
  private bound = false;
  private lastNavAt = 0;
  /** Registered containers, keyed by their host element. */
  private readonly containers = new Map<HTMLElement, ContainerNode>();
  /** Whole-document focusable list, cleared by the observer below; rescanning hundreds of cards per D-pad press stalls the main thread. */
  private focusableCache: HTMLElement[] | null = null;
  private focusObserver?: MutationObserver;

  constructor() {
    // Handler is a no-op for non-arrow keys, so binding on touch-only devices is harmless.
    this.bind();
  }

  private bind() {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;
    const handler = (e: KeyboardEvent) => this.onKey(e);
    // Window only: also listening on document fired each keypress twice.
    window.addEventListener('keydown', handler, { capture: true });
    this.destroyRef.onDestroy(() => window.removeEventListener('keydown', handler, { capture: true } as any));
    // The webOS WebView never scrolls on the Magic Remote wheel: map it to up/down focus moves (TV only).
    // Non-passive so the default scroll can be suppressed.
    const wheelHandler = (e: WheelEvent) => this.onWheel(e);
    window.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
    this.destroyRef.onDestroy(() => window.removeEventListener('wheel', wheelHandler, { capture: true } as any));
    // Track the deepest focused element per container for last-active-child memory.
    const focusInHandler = (e: FocusEvent) => this.updateActiveChild(e.target as HTMLElement | null);
    document.addEventListener('focusin', focusInHandler);
    this.destroyRef.onDestroy(() => document.removeEventListener('focusin', focusInHandler));
    // Clear the cache on DOM changes that affect focusability; attribute filter avoids cosmetic churn.
    if (typeof MutationObserver !== 'undefined') {
      this.focusObserver = new MutationObserver(() => {
        this.focusableCache = null;
      });
      this.focusObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden', 'tabindex', 'inert'],
      });
      this.destroyRef.onDestroy(() => this.focusObserver?.disconnect());
    }
    // Android TV WebView may leave the body unfocused, sending D-pad events to the native View.
    // Desktop opts out: stealing focus on bootstrap is hostile.
    if (this.tv.isTv()) {
      queueMicrotask(() => this.focusFirstIfNoFocus());
    }
  }

  /** Register a container, auto-parented to the closest registered DOM ancestor (DI is too coarse here). */
  registerContainer(
    el: HTMLElement,
    options: { orientation: 'vertical' | 'horizontal'; isWrapping?: boolean },
  ): void {
    if (this.containers.has(el)) return;
    const parent = this.findParentContainer(el);
    this.containers.set(el, {
      el,
      orientation: options.orientation,
      isWrapping: !!options.isWrapping,
      parent,
      activeChild: null,
    });
    // Re-parent existing containers now inside `el`, so registration order doesn't matter.
    for (const c of this.containers.values()) {
      if (c.el === el || !el.contains(c.el)) continue;
      c.parent = this.findParentContainer(c.el);
    }
  }

  unregisterContainer(el: HTMLElement): void {
    const node = this.containers.get(el);
    if (!node) return;
    // Re-parent direct children of this node to its own parent so the tree
    // stays consistent during partial unmounts.
    for (const c of this.containers.values()) {
      if (c.parent === node) c.parent = node.parent;
    }
    this.containers.delete(el);
  }

  private findParentContainer(el: HTMLElement): ContainerNode | null {
    let p = el.parentElement;
    while (p) {
      const c = this.containers.get(p);
      if (c) return c;
      p = p.parentElement;
    }
    return null;
  }

  /** Update activeChild for every ancestor container of the focused element. */
  private updateActiveChild(focused: HTMLElement | null): void {
    if (!focused) return;
    let p: HTMLElement | null = focused.parentElement;
    while (p) {
      const c = this.containers.get(p);
      if (c) c.activeChild = focused;
      p = p.parentElement;
    }
  }

  /** Whole-document focusables, cached between DOM mutations (see focusableCache). */
  private getFocusables(): HTMLElement[] {
    return (this.focusableCache ??= collectFocusables());
  }

  private focusFirstIfNoFocus() {
    if (typeof document === 'undefined') return;
    if (document.activeElement && document.activeElement !== document.body) return;
    // Same choice as the cold-load branch of findNeighbor: the page's declared
    // default beats the first document focusable, which is the topbar.
    const target = this.defaultFocus.currentTarget() ?? this.getFocusables()[0];
    target?.focus({ preventScroll: true });
  }

  private onKey(e: KeyboardEvent) {
    // Some Android WebView builds don't report a `key` for D-pad events but
    // still ship `keyCode` 37/38/39/40 — accept either form.
    const dir = ARROW_TO_DIR[e.key] ?? KEYCODE_TO_DIR[e.keyCode];
    if (!dir) return;
    const active = document.activeElement as HTMLElement | null;
    const tag = active?.tagName;
    const inputType = (active as HTMLInputElement | null)?.type;
    const isMultiLineText = tag === 'TEXTAREA' || tag === 'OPTION' || !!active?.isContentEditable;
    if (isMultiLineText) return;

    // Checkbox/radio/button-style inputs (e.g. DaisyUI toggles) have no native arrow handling and must reach spatial nav.
    const NATIVE_INPUT_TYPES = new Set([
      'text', 'email', 'password', 'search', 'tel', 'url',
      'number', 'range', 'date', 'time', 'datetime-local', 'month', 'week',
    ]);
    const isInputWithNativeArrows = tag === 'INPUT' && NATIVE_INPUT_TYPES.has(inputType ?? 'text');

    // Text inputs keep left/right for the caret until it hits the end, then escape; up/down escape immediately.
    // Range inputs are excluded (arrows adjust the value).
    if (isInputWithNativeArrows && inputType !== 'range' && (dir === 'left' || dir === 'right')) {
      const input = active as HTMLInputElement;
      const value = input.value ?? '';
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      const hasSelection = start !== end;
      const atStart = !hasSelection && start === 0;
      const atEnd = !hasSelection && end === value.length;
      if (dir === 'left' && !atStart) return;
      if (dir === 'right' && !atEnd) return;
      // Caret at boundary → fall through to spatial nav.
    }
    // Native <select> would cycle its value on arrows; block it and reserve arrows for spatial nav.
    if (tag === 'SELECT') {
      e.preventDefault();
    }
    // Sliders own left/right; up/down bubble to the focus tree so focus can't get trapped on the seekbar.
    if (active?.matches('[role="slider"], [data-tv-skip-spatial], [data-tv-skip-spatial] *')) {
      if (dir === 'left' || dir === 'right') return;
      // Unless the slider binds vertical itself (seekbar with chapters while the seek OSD is up).
      if (active.matches('[data-tv-own-vertical]')) return;
    }
    e.preventDefault();
    // crossZones = !e.repeat: a deliberate (non-repeat) press may leave the
    // current zone; a held key's repeats stay inside it.
    const now = Date.now();
    if (e.repeat && now - this.lastNavAt < REPEAT_MIN_INTERVAL_MS) return;
    this.lastNavAt = now;
    this.performMove(dir, !e.repeat);
  }

  /** Move focus to the neighbour in `dir`, or scroll the page when none exists.
   *  `crossZones` false (a held key) keeps focus inside its current zone. */
  private performMove(dir: 'left' | 'right' | 'up' | 'down', crossZones: boolean) {
    const active = document.activeElement as HTMLElement | null;
    const next = this.findNeighbor(dir);
    if (next) {
      // A held key stays in the current zone (row/grid) so leaning on the D-pad can't overshoot out of it.
      if (!crossZones && this.exitsZone(active, next)) return;
      // preventScroll skips the instant auto-scroll; smooth scrollIntoView then animates, horizontal-scroller owns row-top alignment.
      next.focus({ preventScroll: true });
      // Positioned targets (modal close, fixed FABs, sticky headers) are already on screen; scrolling would displace them.
      const pos = typeof getComputedStyle !== 'undefined' ? getComputedStyle(next).position : 'static';
      if (pos !== 'absolute' && pos !== 'fixed' && pos !== 'sticky') {
        next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        // Last so it wins: on the TV WebView smooth scrollIntoView leaves a horizontal scroller untouched, stranding focus off-card.
        this.scrollRowToFocus(next);
      }
      return;
    }
    // No focusable neighbour: scroll the page so the user can reach info content
    // below the last card. Held keys stay put; up/down only; not in a modal.
    if (crossZones && !this.openModals().length && (dir === 'down' || dir === 'up')) {
      const top = dir === 'down' ? PAGE_SCROLL_AMOUNT_PX : -PAGE_SCROLL_AMOUNT_PX;
      window.scrollBy({ top, behavior: 'smooth' });
    }
  }

  /** Bring `el` inside its card row's scrollport, honouring the row's
   *  scroll-padding — the horizontal half of `inline: 'nearest'`. */
  private scrollRowToFocus(el: HTMLElement): void {
    const row = el.closest<HTMLElement>('[data-scroller]');
    if (!row) return;
    const style = getComputedStyle(row);
    const padStart = parseFloat(style.scrollPaddingLeft) || 0;
    const padEnd = parseFloat(style.scrollPaddingRight) || 0;
    const rowLeft = row.getBoundingClientRect().left;
    const rect = el.getBoundingClientRect();
    const start = rect.left - rowLeft - padStart;
    const end = rect.right - rowLeft - (row.clientWidth - padEnd);
    const delta = start < 0 ? start : end > 0 ? end : 0;
    if (delta) row.scrollTo({ left: row.scrollLeft + delta, behavior: 'smooth' });
  }

  /** True when moving to `next` would leave the [data-tv-zone] that currently
   *  holds focus. Elements outside any zone never block. */
  private exitsZone(active: HTMLElement | null, next: HTMLElement): boolean {
    const zone = active?.closest('[data-tv-zone]');
    if (!zone) return false;
    return !zone.contains(next);
  }

  /** Accumulated wheel deltaY, so one notch (~120) is exactly one focus move. */
  private wheelAcc = 0;

  private onWheel(e: WheelEvent) {
    if (!this.tv.isTv()) return;
    // Ignore predominantly-horizontal wheels (trackpads, tilt) — those
    // belong to the horizontal-scroller rows, not vertical navigation.
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    e.preventDefault();
    this.wheelAcc += e.deltaY;
    const STEP = 100;
    while (Math.abs(this.wheelAcc) >= STEP) {
      const dir = this.wheelAcc > 0 ? 'down' : 'up';
      this.wheelAcc -= dir === 'down' ? STEP : -STEP;
      // A wheel is a scroll gesture, not a discrete press, so it may leave the current zone.
      this.performMove(dir, true);
    }
  }

  /** Open overlays scoping navigation: `[data-tv-modal]`, `.dropdown-open .dropdown-content` (closed content stays in the DOM), and open `<dialog>`s. */
  private openModals(): HTMLElement[] {
    return [
      ...Array.from(document.querySelectorAll<HTMLElement>('dialog[open]')),
      ...Array.from(document.querySelectorAll<HTMLElement>('[data-tv-modal]')),
      ...Array.from(
        document.querySelectorAll<HTMLElement>('.dropdown-open .dropdown-content'),
      ),
    ];
  }

  private findNeighbor(dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
    const active = document.activeElement as HTMLElement | null;
    // Modal trap beats tree-aware nav: walking the tree would bridge out to the page behind the dropdown/sheet.
    // Prefer the modal containing focus, else the first open one.
    const modals = this.openModals();
    // Flyout submenus trap up/down; left jumps back to the recorded opener, right has nowhere to go.
    const submenu = active?.closest<HTMLElement>('[data-tv-submenu]') ?? null;
    if (submenu && (dir === 'left' || dir === 'right')) {
      const opener = (submenu as unknown as { __tvOpener?: HTMLElement })
        .__tvOpener;
      return dir === 'left' && opener?.isConnected ? opener : null;
    }
    let openModal: HTMLElement | null;
    if (submenu) {
      openModal = submenu;
    } else {
      // Innermost containing modal: a popover inside an open <dialog> must not pick the enclosing dialog.
      const containing = modals.filter((m) => active && m.contains(active));
      openModal = containing.length
        ? containing.reduce((inner, m) => (inner.contains(m) ? m : inner))
        : modals[0] ?? null;
    }
    if (!openModal && active && active !== document.body && this.containers.size > 0) {
      const tree = this.findNeighborInTree(active, dir);
      if (tree) return tree;
    }
    const all = openModal ? collectFocusables(openModal) : this.getFocusables();
    if (!all.length) return null;

    if (!active || active === document.body) {
      // Nothing focused yet (cold load) — prefer the active page's declared
      // default focus over the first document focusable (which is the topbar).
      return this.defaultFocus.currentTarget() ?? all[0] ?? null;
    }

    const fromRect = active.getBoundingClientRect();
    const fromCx = fromRect.left + fromRect.width / 2;
    const fromCy = fromRect.top + fromRect.height / 2;
    const horizontal = dir === 'left' || dir === 'right';

    // Restrict off-line/anywhere candidates to the active scroller so Right on a row's last card can't land in another row;
    // in-line candidates stay global so Left can reach the sidebar.
    const parentRow = horizontal ? this.findParentContainer(active) : null;
    const activeScroller = horizontal
      ? active.closest<HTMLElement>(SCROLLER_SELECTOR)
        ?? (parentRow?.orientation === 'horizontal' ? parentRow.el : null)
      : null;

    // Three passes: in-line (same row/column, closest), 45 degree cone, then any candidate in the half-plane as last resort.
    const inLine: { el: HTMLElement; primary: number }[] = [];
    const offLine: { el: HTMLElement; score: number }[] = [];
    const anywhere: { el: HTMLElement; score: number }[] = [];

    for (const el of all) {
      if (el === active) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = cx - fromCx;
      const dy = cy - fromCy;

      switch (dir) {
        case 'left':  if (dx >= -4) continue; break;
        case 'right': if (dx <=  4) continue; break;
        case 'up':    if (dy >= -4) continue; break;
        case 'down':  if (dy <=  4) continue; break;
      }

      const sameRowOrCol = horizontal
        ? (r.top < fromRect.bottom && r.bottom > fromRect.top)
        : (r.left < fromRect.right && r.right > fromRect.left);
      const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
      const cross   = horizontal ? Math.abs(dy) : Math.abs(dx);

      if (sameRowOrCol) {
        // Same-band candidates are global so Left from a row's first card reaches the sidebar.
        inLine.push({ el, primary });
      } else if (activeScroller && !activeScroller.contains(el)) {
        // Off-line candidates outside the active row scroller would let
        // Right on the last card jump to a card in a row below. Skip.
        continue;
      } else if (cross <= primary) {
        offLine.push({ el, score: primary * primary + 16 * cross * cross });
      } else {
        // Last-resort: heavy cross-axis penalty, but still considered
        anywhere.push({ el, score: primary * primary + 64 * cross * cross });
      }
    }

    if (inLine.length) {
      inLine.sort((a, b) => a.primary - b.primary);
      return inLine[0].el;
    }
    if (offLine.length) {
      offLine.sort((a, b) => a.score - b.score);
      return offLine[0].el;
    }
    if (anywhere.length) {
      anywhere.sort((a, b) => a.score - b.score);
      return anywhere[0].el;
    }
    return null;
  }

  /** Tree-aware step: climbs from the deepest container, then bridges to a peer top-level one; null falls back to rect scoring. */
  private findNeighborInTree(active: HTMLElement, dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
    const activeRect = active.getBoundingClientRect();
    const activeCx = activeRect.left + activeRect.width / 2;
    let cur = this.findParentContainer(active);
    let topMost: ContainerNode | null = null;
    while (cur) {
      topMost = cur;
      const horizontal = cur.orientation === 'horizontal';
      const orientationMatches = horizontal === (dir === 'left' || dir === 'right');
      if (orientationMatches) {
        const children = this.getNavigableChildren(cur);
        // Find the navigable child that holds the active element (it might
        // be a focusable leaf === active, or a sub-container containing it).
        const ownChild = children.find((c) => c === active || c.contains(active));
        if (ownChild) {
          const idx = children.indexOf(ownChild);
          const step = dir === 'right' || dir === 'down' ? 1 : -1;
          let nextIdx = idx + step;
          if (cur.isWrapping && children.length > 0) {
            nextIdx = (nextIdx + children.length) % children.length;
          }
          if (nextIdx >= 0 && nextIdx < children.length) {
            // Vertical steps land under the item being left; horizontal steps take the literal sibling.
            return this.digDown(children[nextIdx], !horizontal, horizontal ? undefined : activeCx);
          }
        }
      }
      cur = cur.parent;
    }
    // Bridge to a peer top-level container so an isolated container's edge doesn't fall through to a far-away rect match.
    if (topMost) {
      const peer = this.findPeerContainer(topMost, dir);
      // Peer bridging only ever fires for up/down (see findPeerContainer), so
      // entering the peer region keeps the column the user was on.
      if (peer) return this.digDown(peer.el, true, activeCx);
    }
    return null;
  }

  /** Closest top-level container, vertical only: overlapping regions on one band make left/right ambiguous (rect fallback). */
  private findPeerContainer(
    from: ContainerNode,
    dir: 'left' | 'right' | 'up' | 'down',
  ): ContainerNode | null {
    if (dir !== 'up' && dir !== 'down') return null;
    const fromRect = from.el.getBoundingClientRect();
    const fromCx = fromRect.left + fromRect.width / 2;
    const fromCy = fromRect.top + fromRect.height / 2;

    let best: ContainerNode | null = null;
    let bestScore = Infinity;
    for (const c of this.containers.values()) {
      if (c === from || c.parent !== null) continue;
      if (!isRendered(c.el)) continue;
      const r = c.el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // Center in direction AND extending past the source: catches overlapping regions an edge check misses.
      const inDirection =
        dir === 'down'
          ? cy > fromCy && r.bottom > fromRect.bottom
          : cy < fromCy && r.top < fromRect.top;
      if (!inDirection) continue;
      const dx = Math.abs(cx - fromCx);
      const dy = Math.abs(cy - fromCy);
      const score = dy + 2 * dx;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  /** Resolve a child to a leaf: remembered activeChild, `autofocus` descendant, then first child; `preferFirst` skips the first two. */
  private digDown(el: HTMLElement, preferFirst = false, alignCx?: number): HTMLElement | null {
    const c = this.containers.get(el);
    if (!c) return el; // it's a leaf focusable
    if (!preferFirst && c.activeChild && c.el.contains(c.activeChild) && isFocusCandidate(c.activeChild)) {
      return c.activeChild;
    }
    if (!preferFirst) {
      const auto = c.el.querySelector<HTMLElement>('[autofocus]');
      if (auto && isFocusCandidate(auto)) return auto;
    }
    let children = this.getNavigableChildren(c);
    // Entering a row from above or below: try the children nearest the column
    // the user was on first, so focus lands under the card it came from.
    if (alignCx !== undefined && c.orientation === 'horizontal') {
      const distance = (child: HTMLElement) => {
        const r = child.getBoundingClientRect();
        return Math.abs(r.left + r.width / 2 - alignCx);
      };
      children = [...children].sort((a, b) => distance(a) - distance(b));
    }
    for (const child of children) {
      const dug = this.digDown(child, preferFirst, alignCx);
      if (dug) return dug;
    }
    return null;
  }

  /** Registered direct sub-containers plus focusable leaves not inside a deeper container. */
  private getNavigableChildren(container: ContainerNode): HTMLElement[] {
    const out: HTMLElement[] = [];
    const visit = (el: HTMLElement) => {
      // A registered sub-container: it is itself a navigable child; do not
      // descend (the recursion stops, its own children belong to its tree).
      if (el !== container.el && this.containers.has(el)) {
        if (isRendered(el)) out.push(el);
        return;
      }
      // A focusable leaf at this level — treat as navigable, do not descend.
      if (matchesFocusable(el) && isFocusCandidate(el)) {
        out.push(el);
        return;
      }
      // Otherwise descend.
      for (const child of Array.from(el.children) as HTMLElement[]) {
        visit(child);
      }
    };
    for (const child of Array.from(container.el.children) as HTMLElement[]) {
      visit(child);
    }
    return out;
  }
}

function matchesFocusable(el: HTMLElement): boolean {
  return el.matches?.(FOCUSABLE_SELECTOR) ?? false;
}

const ARROW_TO_DIR: Record<string, 'left' | 'right' | 'up' | 'down' | undefined> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

const KEYCODE_TO_DIR: Record<number, 'left' | 'right' | 'up' | 'down' | undefined> = {
  37: 'left',
  38: 'up',
  39: 'right',
  40: 'down',
};

function collectFocusables(root: ParentNode = document): HTMLElement[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const visible = nodes.filter((el) => {
    const style = getComputedStyle(el);
    if (!isFocusCandidate(el, style)) return false;
    if (style.pointerEvents === 'none') return false;
    const r = el.getBoundingClientRect();
    // Reject only elements positioned off-document (DaisyUI drawer-toggle at left:-100%), not scrolled-out ones:
    // those are valid targets, focusing scrolls them into view.
    if (r.right <= 0 || r.bottom <= 0) {
      const inScroller = el.closest(SCROLLER_SELECTOR);
      const docRight = r.right + window.scrollX;
      const docBottom = r.bottom + window.scrollY;
      if (!inScroller && (docRight <= 0 || docBottom <= 0)) return false;
    }
    return true;
  });
  // Keep outermost focusables only: a card's inner buttons/links must not become separate targets.
  const set = new Set(visible);
  return visible.filter((el) => {
    let p = el.parentElement;
    while (p) {
      if (set.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });
}
