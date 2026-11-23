import { Injectable, inject, DestroyRef } from '@angular/core';
import { TvService } from './tv.service';
import { DefaultFocusService } from './default-focus.service';
import {
  FOCUSABLE_SELECTOR,
  SCROLLER_SELECTOR,
  SELECTED_MARKERS,
  focusOverlayEntry,
  initialOverlayFocus,
  isFocusCandidate,
  isRendered,
  wantsFocusRestore,
} from './focusable.constants';
import { fitsAtPageTop, rowSnapPending } from '../utils/focus-snap.util';

/** Spatial navigation for D-pad and keyboard arrows: container tree (`[appTvSection]`/`[appTvRow]`) first,
 *  rect fallback outside any container. Keys are caught in capture phase to pre-empt native consumers. */

interface ContainerNode {
  readonly el: HTMLElement;
  readonly orientation: 'vertical' | 'horizontal' | 'grid';
  readonly isWrapping: boolean;
  /** Last focusable that received focus inside this container (or any
   * descendant). Used to dig down on re-entry. */
  activeChild: HTMLElement | null;
}

/** Page scroll step (px) when an up/down move has no focusable neighbour — lets
 *  the user reach non-focusable info content below the last card. */
const PAGE_SCROLL_AMOUNT_PX = 300;

/** How long a lost focus waits for its button to come back (re-enabled or replaced) before giving up. */
const FOCUS_RESCUE_MS = 5000;

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
  /** Focusables per root (the document, a grid, a modal, a scroller): rescanning hundreds of cards per D-pad press stalls the main thread. */
  private readonly focusableCache = new Map<ParentNode, HTMLElement[]>();
  private focusObserver?: MutationObserver;
  /** The focused element, its parent and spot, to hand the focus on when a click swaps or disables it. */
  private lastFocus: { el: HTMLElement; parent: HTMLElement | null; overlay: HTMLElement | null; rect: DOMRect } | null = null;
  private focusLostAt = 0;
  /** The last element focused outside the rail and overlays: where Right from the rail returns. */
  private lastPageFocus: HTMLElement | null = null;

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
    // The webOS WebView never scrolls on the Magic Remote wheel: map it to up/down focus moves.
    // Non-passive so the default scroll can be suppressed.
    if (this.tv.isTv()) {
      const wheelHandler = (e: WheelEvent) => this.onWheel(e);
      window.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
      this.destroyRef.onDestroy(() => window.removeEventListener('wheel', wheelHandler, { capture: true } as any));
    }
    // Track the deepest focused element per container for last-active-child memory.
    const focusInHandler = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      this.updateActiveChild(target);
      this.rememberFocus();
      if (target && !target.closest('[data-tv-nav], [data-tv-modal], dialog')) this.lastPageFocus = target;
    };
    document.addEventListener('focusin', focusInHandler);
    this.destroyRef.onDestroy(() => document.removeEventListener('focusin', focusInHandler));
    // Drop the lists a DOM change can affect; attribute filter avoids cosmetic churn.
    // Rooted at <html>, not <body>: dropdowns and popover menus mount there.
    if (typeof MutationObserver !== 'undefined') {
      this.focusObserver = new MutationObserver((records) => {
        this.dropStaleFocusables(records);
        this.rescueFocus(records);
      });
      this.focusObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden', 'tabindex', 'inert'],
      });
      this.destroyRef.onDestroy(() => this.focusObserver?.disconnect());
    }
    // A breakpoint can show or hide focusables without any mutation.
    const resizeHandler = () => this.focusableCache.clear();
    window.addEventListener('resize', resizeHandler, { passive: true });
    this.destroyRef.onDestroy(() => window.removeEventListener('resize', resizeHandler));
    // Android TV WebView may leave the body unfocused, sending D-pad events to the native View.
    // Desktop opts out: stealing focus on bootstrap is hostile.
    if (this.tv.isTv()) {
      queueMicrotask(() => this.focusFirstIfNoFocus());
    }
  }

  /** Register a container; its parent is the closest registered DOM ancestor, looked up at each step
   *  since projected content registers before it is attached under that ancestor. */
  registerContainer(
    el: HTMLElement,
    options: { orientation: 'vertical' | 'horizontal' | 'grid'; isWrapping?: boolean },
  ): void {
    if (this.containers.has(el)) return;
    this.containers.set(el, {
      el,
      orientation: options.orientation,
      isWrapping: !!options.isWrapping,
      activeChild: null,
    });
  }

  unregisterContainer(el: HTMLElement): void {
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

  /** Focusables under `root`, cached until a mutation can change them (see dropStaleFocusables). */
  private focusablesIn(root: ParentNode = document): HTMLElement[] {
    let list = this.focusableCache.get(root);
    if (!list) this.focusableCache.set(root, (list = collectFocusables(root)));
    return list;
  }

  /** Nodes added or removed inside a root, or a relevant attribute on, inside or above it, stale its list;
   *  a class or style change on a node holding no focusable changes no list. */
  private dropStaleFocusables(records: MutationRecord[]): void {
    if (!this.focusableCache.size) return;
    const added: Node[] = [];
    const attributes: Node[] = [];
    for (const r of records) {
      if (r.type === 'childList') added.push(r.target);
      else if ((r.attributeName !== 'class' && r.attributeName !== 'style') || holdsFocusable(r.target)) attributes.push(r.target);
    }
    if (!added.length && !attributes.length) return;
    for (const root of this.focusableCache.keys()) {
      const node = root as Node;
      const stale =
        node === document ||
        !node.isConnected ||
        added.some((t) => node.contains(t)) ||
        attributes.some((t) => node.contains(t) || t.contains(node));
      if (stale) this.focusableCache.delete(root);
    }
  }

  private rememberFocus(): void {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return;
    this.lastFocus = {
      el,
      parent: el.parentElement,
      overlay: el.closest<HTMLElement>('[data-tv-modal], dialog[open]'),
      rect: el.getBoundingClientRect(),
    };
    this.focusLostAt = 0;
  }

  /** A pressed button that vanished (swapped by an `@if`), moved (a keyed list reordering) or got disabled (busy) drops
   *  the focus on <body>: hand it to the menu's current choice, else back to the button, else to its nearest replacement
   *  under the same parent, else (a menu panel swapped whole) to its overlay's entry. Keyboard/D-pad only. */
  private rescueFocus(records: MutationRecord[]): void {
    const last = this.lastFocus;
    if (!last || !wantsFocusRestore()) return;
    const { el, parent, overlay, rect } = last;
    const gone = !el.isConnected;
    const moved = !gone && records.some((r) => Array.from(r.removedNodes).some((n) => n === el || n.contains(el)));
    // A blur on a button still there, in place and enabled was on purpose.
    if (!this.focusLostAt && (gone || moved || el.matches(':disabled'))) this.focusLostAt = Date.now();
    if (!this.focusLostAt || document.activeElement !== document.body) return;
    if (Date.now() - this.focusLostAt > FOCUS_RESCUE_MS) {
      this.lastFocus = null;
      return;
    }
    if (!parent?.isConnected) {
      if (overlay?.isConnected) focusOverlayEntry(initialOverlayFocus(overlay));
      else this.lastFocus = null;
      return;
    }
    // The option just picked in a single-choice menu is its current choice, wherever the list put it.
    const picked = SELECTED_MARKERS.map((m) => parent.querySelector<HTMLElement>(m)).find((c) => c && isFocusCandidate(c));
    if (picked) {
      picked.focus({ preventScroll: true });
      return;
    }
    if (!gone) {
      if (!el.matches(':disabled')) el.focus({ preventScroll: true });
      return;
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let best: HTMLElement | null = null;
    let bestDist = Infinity;
    for (const c of collectFocusables(parent)) {
      const r = c.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
      if (d < bestDist) [best, bestDist] = [c, d];
    }
    best?.focus({ preventScroll: true });
  }

  private focusFirstIfNoFocus() {
    if (typeof document === 'undefined') return;
    if (document.activeElement && document.activeElement !== document.body) return;
    // Same choice as the cold-load branch of findNeighbor: the page's declared
    // default beats the first document focusable, which is the topbar.
    const target = this.defaultFocus.currentTarget() ?? this.focusablesIn()[0];
    target?.focus({ preventScroll: true });
  }

  private onKey(e: KeyboardEvent) {
    // The spot is taken before Enter activates, so a replacement lands where the press was.
    this.rememberFocus();
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
    let caretEscapes = false;
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
      caretEscapes = true;
    }
    // Native <select> would cycle its value on arrows; block it and reserve arrows for spatial nav.
    if (tag === 'SELECT') {
      e.preventDefault();
    }
    // Sliders own left/right; up/down bubble to the focus tree so focus can't get trapped on the seekbar.
    if (active?.matches('[role="slider"], [data-tv-skip-spatial], [data-tv-skip-spatial] *')) {
      // A text field marked this way still hands the arrow on once its caret sits at the edge.
      if ((dir === 'left' || dir === 'right') && !caretEscapes) return;
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
      // preventScroll skips the instant auto-scroll; scrollToFocus then animates, horizontal-scroller owns row-top alignment.
      next.focus({ preventScroll: true });
      // Positioned targets (modal close, fixed FABs, sticky headers) are already on screen; scrolling would displace them.
      const style = typeof getComputedStyle !== 'undefined' ? getComputedStyle(next) : null;
      const pos = style?.position ?? 'static';
      if (style && pos !== 'absolute' && pos !== 'fixed' && pos !== 'sticky') this.scrollToFocus(next, style);
      return;
    }
    // No focusable neighbour: scroll the page so the user can reach info content
    // below the last card. Held keys stay put; up/down only; not in a modal.
    // The rail is not the page: its ends stop the step instead of scrolling the content behind it.
    if (crossZones && !this.openModals().length && !active?.closest('[data-tv-nav]') && (dir === 'down' || dir === 'up')) {
      // Nothing focusable above: all that is left to show is the top of the page.
      if (dir === 'up') window.scrollTo({ top: 0, behavior: 'smooth' });
      else window.scrollBy({ top: PAGE_SCROLL_AMOUNT_PX, behavior: 'smooth' });
    }
  }

  /** One smooth scroll per scroller: the row snap or a page reveal moves the page, the card row and inner
   *  vertical scrollers scroll themselves; two animations on one scroller judder. */
  private scrollToFocus(el: HTMLElement, style: CSSStyleDeclaration): void {
    // The rail is viewport-bound: moving in it scrolls its own list, never the page.
    if (el.closest('[data-tv-nav]')) {
      this.scrollWithinList(el);
      return;
    }
    const scrollers = verticalScrollers(el);
    const row = el.closest<HTMLElement>('[data-scroller]');
    if (scrollers.length) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    else if (!rowSnapPending(el)) {
      // An element of the first screen brings the page back to the very top instead of a partial `nearest` scroll.
      if (fitsAtPageTop(el.getBoundingClientRect(), window.scrollY)) {
        if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (row) this.revealInPage(el, style);
      else el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    this.scrollEdgeToFocus(el, scrollers);
    // Last so it wins: on the TV WebView smooth scrollIntoView leaves a horizontal scroller untouched, stranding focus off-card.
    if (row) this.scrollRowToFocus(el, row);
  }

  /** Keeps `el` inside its nearest vertical scroller without touching the scrollers above it. */
  private scrollWithinList(el: HTMLElement): void {
    const list = verticalScrollers(el)[0];
    if (!list) return;
    const r = el.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    const delta = r.top < b.top ? r.top - b.top : r.bottom > b.bottom ? r.bottom - b.bottom : 0;
    if (delta) list.scrollBy({ top: delta, behavior: 'smooth' });
  }

  /** The vertical half of `nearest` on the page, for a card whose row scrolls itself sideways. */
  private revealInPage(el: HTMLElement, style: CSSStyleDeclaration): void {
    const page = getComputedStyle(document.documentElement);
    const r = el.getBoundingClientRect();
    const delta = nearestDelta(
      r.top - (parseFloat(style.scrollMarginTop) || 0),
      r.bottom + (parseFloat(style.scrollMarginBottom) || 0),
      parseFloat(page.scrollPaddingTop) || 0,
      document.documentElement.clientHeight - (parseFloat(page.scrollPaddingBottom) || 0),
    );
    if (delta) window.scrollBy({ top: delta, behavior: 'smooth' });
  }

  /** A vertical scroller's first or last row scrolls it to that edge: `nearest` stops at the item's box,
   *  short of the padding, a heading or a badge beside it, and clips the ring. */
  private scrollEdgeToFocus(el: HTMLElement, scrollers: HTMLElement[]): void {
    if (!scrollers.length) return;
    const r = el.getBoundingClientRect();
    for (const s of scrollers) {
      const others = this.focusablesIn(s).map((o) => o.getBoundingClientRect());
      if (!others.some((o) => o.bottom <= r.top)) s.scrollTo({ top: 0, behavior: 'smooth' });
      else if (!others.some((o) => o.top >= r.bottom)) s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' });
    }
  }

  /** Bring `el` inside its card row's scrollport, honouring the row's
   *  scroll-padding — the horizontal half of `inline: 'nearest'`. */
  private scrollRowToFocus(el: HTMLElement, row: HTMLElement): void {
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

  /** The rail is a column of its own: steps between it and the page go through its entry and the page memory only. */
  private findNeighbor(dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
    const active = document.activeElement as HTMLElement | null;
    const next = this.findNeighborIn(dir);
    const rail = this.rail();
    if (!rail || !active) return next;
    if (rail.el.contains(active)) {
      // Up and down end at the rail's own edges instead of drifting into the page.
      return next && (dir === 'up' || dir === 'down') && !rail.el.contains(next) ? null : next;
    }
    if (!next || !rail.el.contains(next)) return next;
    // The rail is entered with Left only: Up or Down at a page's edge stays put.
    return dir === 'left' ? this.railEntry(rail) : null;
  }

  private rail(): ContainerNode | null {
    return Array.from(this.containers.values()).find((c) => c.el.hasAttribute('data-tv-nav') && isRendered(c.el)) ?? null;
  }

  private railEntry(rail: ContainerNode): HTMLElement | null {
    return rail.el.querySelector<HTMLElement>('[aria-current="page"]') ?? this.digDown(rail.el);
  }

  private findNeighborIn(dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
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
    // Inside a modal the tree still orders a section's children, as long as the step stays in the modal.
    if (active && active !== document.body && this.containers.size > 0 && (!openModal || this.inContainerWithin(active, openModal))) {
      const tree = this.findNeighborInTree(active, dir);
      if (tree && (!openModal || openModal.contains(tree))) return tree;
    }
    const all = this.focusablesIn(openModal ?? document);
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
    const inLine: { el: HTMLElement; primary: number; cross: number }[] = [];
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
        inLine.push({ el, primary, cross });
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
      // Ties on the step axis (a row of buttons under a seekbar) go to the one aligned with the active element.
      inLine.sort((a, b) => a.primary - b.primary || a.cross - b.cross);
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
  /** `el` sits in a registered container that is itself inside `root`. */
  private inContainerWithin(el: HTMLElement, root: HTMLElement): boolean {
    const c = this.findParentContainer(el);
    return !!c && root.contains(c.el);
  }

  private findNeighborInTree(active: HTMLElement, dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
    const activeRect = active.getBoundingClientRect();
    const activeCx = activeRect.left + activeRect.width / 2;
    let cur = this.findParentContainer(active);
    let topMost: ContainerNode | null = null;
    while (cur) {
      topMost = cur;
      // A grid moves by geometry inside itself; only its edge hands the step to the enclosing container.
      if (cur.orientation === 'grid') {
        const inGrid = nearestInDirection(this.focusablesIn(cur.el), active, dir);
        if (inGrid) return inGrid;
        cur = this.findParentContainer(cur.el);
        continue;
      }
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
          // Siblings sharing the active child's band (a header's buttons in a vertical section) are not a step on this axis.
          const from = ownChild.getBoundingClientRect();
          while (nextIdx >= 0 && nextIdx < children.length && sharesBand(children[nextIdx].getBoundingClientRect(), from, horizontal)) {
            nextIdx += step;
          }
          // A looping row still lets Left out of its first child when a rail sits at the screen's left edge.
          const leavesToRail = dir === 'left' && idx === 0 && !!this.rail();
          if (cur.isWrapping && children.length > 0 && !leavesToRail) {
            nextIdx = (nextIdx + children.length) % children.length;
          }
          if (nextIdx >= 0 && nextIdx < children.length) {
            // Vertical steps land under the item being left; horizontal steps take the literal sibling.
            return this.digDown(children[nextIdx], !horizontal, horizontal ? undefined : activeCx);
          }
        }
      }
      cur = this.findParentContainer(cur.el);
    }
    // Left and right cross between the rail and the page, which the rect fallback would match at random.
    if (topMost && (dir === 'left' || dir === 'right')) return this.bridgeRail(topMost, dir, active);
    // Bridge to a peer top-level container so an isolated container's edge doesn't fall through to a far-away rect match.
    if (topMost) {
      const peer = this.findPeerContainer(topMost, dir);
      // Peer bridging only ever fires for up/down (see findPeerContainer), so
      // entering the peer region keeps the column the user was on.
      if (peer) return this.digDown(peer.el, true, activeCx);
    }
    return null;
  }

  /** Where focus goes back to from the rail: the last page focus, else the page's first container. */
  private pageReturn(rail: ContainerNode): HTMLElement | null {
    const last = this.lastPageFocus;
    if (last?.isConnected && isFocusCandidate(last)) return last;
    const page = Array.from(this.containers.values()).find(
      (c) => c !== rail && !this.findParentContainer(c.el) && c.el.closest('main') && isRendered(c.el),
    );
    return page ? this.digDown(page.el) : null;
  }

  /** Back and the rail: a top-level page opens it on its current entry, a deeper one leaves it for the page as Right would.
   *  False when Back goes on: the rail already holds focus on a top-level page, or neither applies. */
  railBack(topLevel: boolean): boolean {
    const rail = this.rail();
    const active = document.activeElement as HTMLElement | null;
    if (!rail) return false;
    const inRail = !!active && rail.el.contains(active);
    if (topLevel === inRail) return false;
    const target = topLevel ? this.railEntry(rail) : this.pageReturn(rail);
    if (!target) return false;
    target.focus({ preventScroll: true });
    this.scrollToFocus(target, getComputedStyle(target));
    return true;
  }

  /** The rail: Left from a page container's edge enters it on the current entry, Right from it returns to the page. */
  private bridgeRail(from: ContainerNode, dir: 'left' | 'right', active: HTMLElement): HTMLElement | null {
    const rail = this.rail();
    if (!rail) return null;
    if (from === rail) return dir === 'right' ? this.pageReturn(rail) : null;
    // Only from the leftmost focusable of its band: a neighbour on the same line wins.
    if (dir !== 'left') return null;
    const band = active.getBoundingClientRect();
    const inBand = this.focusablesIn(from.el).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top < band.bottom && r.bottom > band.top;
    });
    if (nearestInDirection(inBand, active, 'left')) return null;
    return this.railEntry(rail);
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
      if (c === from || this.findParentContainer(c.el)) continue;
      // The rail sits beside the page: up and down never reach it.
      if (c.el.hasAttribute('data-tv-nav') || !isRendered(c.el)) continue;
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

  /** Resolve a child to a leaf: the child marked `aria-current` (the active dot, the page shown), else remembered activeChild,
   *  `autofocus` descendant, then first child; `preferFirst` skips memory and autofocus, never the current child. */
  private digDown(el: HTMLElement, preferFirst = false, alignCx?: number): HTMLElement | null {
    const c = this.containers.get(el);
    if (!c) return el; // it's a leaf focusable
    const current = this.getNavigableChildren(c).find((ch) => {
      const v = ch.getAttribute('aria-current');
      return !!v && v !== 'false';
    });
    if (current) {
      const dug = this.digDown(current, preferFirst, alignCx);
      if (dug) return dug;
    }
    if (!preferFirst && c.activeChild && c.el.contains(c.activeChild) && isFocusCandidate(c.activeChild)) {
      return c.activeChild;
    }
    if (!preferFirst) {
      const auto = c.el.querySelector<HTMLElement>('[autofocus]');
      if (auto && isFocusCandidate(auto)) return auto;
    }
    let children = this.getNavigableChildren(c);
    // Entering a row from above or below: its autofocus item (a hero's Play) if it has one, else
    // the children nearest the column the user was on, so focus lands under the card it came from.
    if (alignCx !== undefined && c.orientation === 'horizontal') {
      const auto = c.el.querySelector<HTMLElement>('[autofocus]');
      if (auto && isFocusCandidate(auto)) return auto;
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

/** The candidate closest to `from` in `dir`, weighing drift across the axis double. */
export function nearestInDirection(candidates: HTMLElement[], from: HTMLElement, dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
  const f = from.getBoundingClientRect();
  const fx = f.left + f.width / 2;
  const fy = f.top + f.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    if (el === from) continue;
    const r = el.getBoundingClientRect();
    // A cached list can hold an element hidden since by a stylesheet alone.
    if (r.width === 0 || r.height === 0) continue;
    const dx = r.left + r.width / 2 - fx;
    const dy = r.top + r.height / 2 - fy;
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    if (along <= 4) continue;
    const score = along + 2 * Math.abs(dir === 'left' || dir === 'right' ? dy : dx);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** `r` overlaps `from` along the step axis: beside it in a vertical step, above or below it in a horizontal one. */
export function sharesBand(r: DOMRect, from: DOMRect, horizontal: boolean): boolean {
  // Half the smaller extent: a row's focus-ring padding overlapping the heading above it is not a shared band.
  const [a0, a1, b0, b1] = horizontal ? [r.left, r.right, from.left, from.right] : [r.top, r.bottom, from.top, from.bottom];
  return Math.min(a1, b1) - Math.max(a0, b0) > Math.min(a1 - a0, b1 - b0) / 2;
}

function matchesFocusable(el: HTMLElement): boolean {
  return el.matches?.(FOCUSABLE_SELECTOR) ?? false;
}

/** `node` is a focusable or holds one, so a class or style change on it can change a focusable list. */
function holdsFocusable(node: Node): boolean {
  return node instanceof Element && (node.matches(FOCUSABLE_SELECTOR) || node.querySelector(FOCUSABLE_SELECTOR) !== null);
}

/** Scrollers between `el` and `<body>` that scroll vertically, innermost first; the page itself is not one. */
function verticalScrollers(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let s = el.parentElement; s && s !== document.body; s = s.parentElement) {
    if (s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY)) out.push(s);
  }
  return out;
}

/** Scroll that `block: 'nearest'` applies to a box spanning `top`..`bottom` in a view spanning `viewTop`..`viewBottom`. */
export function nearestDelta(top: number, bottom: number, viewTop: number, viewBottom: number): number {
  const before = top < viewTop;
  const after = bottom > viewBottom;
  if (before === after) return 0;
  const taller = bottom - top > viewBottom - viewTop;
  return before !== taller ? top - viewTop : bottom - viewBottom;
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
