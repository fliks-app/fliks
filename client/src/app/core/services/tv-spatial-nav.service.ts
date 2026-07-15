import { Injectable, inject, DestroyRef } from '@angular/core';
import { TvService } from './tv.service';
import { DefaultFocusService } from './default-focus.service';
import { FOCUSABLE_SELECTOR } from './focusable.constants';

/**
 * Spatial navigation for D-pad input on Android TV — and keyboard
 * arrow keys on desktop / laptop. Same algorithm, same container
 * tree; the gating is removed so any pointer device benefits. The
 * TV-only quirks (forced initial focus, `body.tv` 10-foot styling)
 * stay scoped via the `tv.isTv()` checks they already had.
 *
 * Two cooperating layers:
 *
 * 1. **Container tree** (opt-in) — pages annotate sections with
 *    `[appTvSection]` (vertical) / `[appTvRow]` (horizontal). Each
 *    directive registers its element here, building a logical tree that
 *    groups focusables by intent. Within an annotated zone the focus
 *    walks the tree (last-active child memorised per container). A
 *    vertical step into a new row lands on that row's first item; a
 *    horizontal step within a row still restores the last-focused card.
 *
 * 2. **Rect-based fallback** — for any focus that lives outside an
 *    annotated container the original three-pass scoring runs (in-line
 *    → 45° cone → half-plane), so unmigrated pages keep working
 *    unchanged. Migration is therefore strictly incremental.
 *
 * `findNeighbor` consults the tree first; on miss (or if the active
 * element isn't inside any registered container) the rect-based pass
 * runs. Keys are intercepted on the capture phase so `<select>` arrow
 * cycling and other native consumers are pre-empted.
 */

interface ContainerNode {
  readonly el: HTMLElement;
  readonly orientation: 'vertical' | 'horizontal';
  readonly isWrapping: boolean;
  parent: ContainerNode | null;
  /** Last focusable that received focus inside this container (or any
   * descendant). Used to dig down on re-entry. */
  activeChild: HTMLElement | null;
}

/** Minimum ms between focus moves. A held key (auto-repeat) and fast taps both
 *  fire faster than a smooth scroll settles, which judders as each move
 *  retargets the animation. Pace moves to this interval; the dispatcher is
 *  leading + trailing so no press is dropped, only delayed. */
const NAV_MIN_INTERVAL_MS = 300;

/** Page scroll step (px) when an up/down move has no focusable neighbour — lets
 *  the user reach non-focusable info content below the last card. */
const PAGE_SCROLL_AMOUNT_PX = 300;

@Injectable({ providedIn: 'root' })
export class TvSpatialNavService {
  private readonly tv = inject(TvService);
  private readonly defaultFocus = inject(DefaultFocusService);
  private readonly destroyRef = inject(DestroyRef);
  private bound = false;
  /** Timestamp of the last performed spatial-nav move (for pacing). */
  private lastNavAt = 0;
  private pendingNavTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingNavDir: 'left' | 'right' | 'up' | 'down' = 'down';
  private pendingCrossZones = false;
  /** Registered containers, keyed by their host element. */
  private readonly containers = new Map<HTMLElement, ContainerNode>();
  /** Cached whole-document focusable list, reused until the DOM mutates. When
   *  no tree container matches the active element (e.g. the library grid),
   *  findNeighbor scans the whole document on every D-pad press, and
   *  querySelectorAll + getComputedStyle over hundreds of cards per press
   *  stalls the main thread. A pure scroll/focus move mutates nothing, so the
   *  list stays valid between presses; the observer below clears it on change. */
  private focusableCache: HTMLElement[] | null = null;
  private focusObserver?: MutationObserver;

  constructor() {
    // Bind unconditionally — desktop / laptop users press arrow keys
    // expecting spatial focus moves, and the handler is a no-op for
    // any non-arrow key. Touch-only phones never fire arrow keydowns
    // so binding there has no observable effect.
    this.bind();
  }

  private bind() {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;
    const handler = (e: KeyboardEvent) => this.onKey(e);
    // Single listener on window (capture phase) — earlier we doubled up with
    // document AND window which made each keypress fire the handler twice and
    // skip every other card on horizontal nav.
    window.addEventListener('keydown', handler, { capture: true });
    this.destroyRef.onDestroy(() => window.removeEventListener('keydown', handler, { capture: true } as any));
    // The LG Magic Remote's scroll wheel emits standard `wheel` events
    // (deltaY ±120 per notch) but the webOS WebView never scrolls the page
    // in response, so the wheel feels dead. Translate vertical wheel into
    // the same up/down focus moves the D-pad makes — TV only, so the mouse
    // wheel keeps its native page-scroll on desktop. Non-passive so the
    // (no-op on webOS) default can be suppressed and double-scroll avoided
    // on any platform that does scroll natively.
    const wheelHandler = (e: WheelEvent) => this.onWheel(e);
    window.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
    this.destroyRef.onDestroy(() => window.removeEventListener('wheel', wheelHandler, { capture: true } as any));
    // Track the deepest focused element inside each registered container so
    // re-entering a container can dig back to the same leaf (last-active-child
    // memory). Bubble phase is fine: focusin always reaches the document.
    const focusInHandler = (e: FocusEvent) => this.updateActiveChild(e.target as HTMLElement | null);
    document.addEventListener('focusin', focusInHandler);
    this.destroyRef.onDestroy(() => document.removeEventListener('focusin', focusInHandler));
    // Invalidate the focusable cache whenever the DOM that could change the
    // focusable set changes. Scoped to the attributes that flip an element's
    // focusability/visibility (not every attribute) so cosmetic churn doesn't
    // thrash the cache; childList/subtree covers infinite-scroll card adds.
    if (typeof MutationObserver !== 'undefined') {
      this.focusObserver = new MutationObserver(() => {
        this.focusableCache = null;
      });
      this.focusObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden', 'tabindex'],
      });
      this.destroyRef.onDestroy(() => this.focusObserver?.disconnect());
    }
    // Android TV WebView often leaves the body un-focused on first paint, which
    // means D-pad events are consumed by the native View and never reach JS.
    // Pushing focus to the first interactive element guarantees subsequent
    // keydowns are dispatched into our handler.
    // Desktop / laptop opt out — stealing focus on bootstrap from whatever
    // the browser would otherwise restore (e.g. a form input on a refresh)
    // is hostile, and arrow keys reach the body fine anyway.
    if (this.tv.isTv()) {
      queueMicrotask(() => this.focusFirstIfNoFocus());
    }
  }

  /**
   * Register a container. Called by `[appTvSection]` / `[appTvRow]` on init.
   * Parent is auto-resolved by walking up to the closest registered ancestor
   * — DI is too coarse here because the host element of a directive may not
   * itself be the registered host (e.g. a row inside another component's
   * template). Walking the live DOM tree captures that automatically.
   */
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
    // Re-resolve the parent for every existing container that lies inside
    // `el`. Two cases this handles:
    //   - A descendant registered before us with `parent: null` (init race).
    //   - A descendant whose previous parent was an ancestor of us, but `el`
    //     is now the closest ancestor (we slot in between).
    // Iterating with the live `findParentContainer` guarantees correctness
    // regardless of registration order.
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
    const all = this.getFocusables();
    all[0]?.focus({ preventScroll: true });
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

    // Inputs without native arrow handling — checkbox/radio/button-style
    // — must always fall through to the spatial-nav tree, regardless of
    // platform, or the user gets focus-trapped on the field. Toggles
    // (DaisyUI `.toggle` is a styled `<input type="checkbox">`) are the
    // canonical example: no caret, no value cycle, arrows would just
    // dead-end without this.
    const NATIVE_INPUT_TYPES = new Set([
      'text', 'email', 'password', 'search', 'tel', 'url',
      'number', 'range', 'date', 'time', 'datetime-local', 'month', 'week',
    ]);
    const isInputWithNativeArrows = tag === 'INPUT' && NATIVE_INPUT_TYPES.has(inputType ?? 'text');

    // Text-style inputs own horizontal arrows (caret movement) — defer
    // left/right to native UNTIL the caret hits the end of the value, at
    // which point the arrow should escape to spatial nav instead of
    // dead-ending on a no-op caret move. Up/down don't move the caret on
    // single-line inputs, so they escape unconditionally. Range inputs
    // are excluded (their arrows adjust the value on every axis).
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
    // Native `<select>` cycles its options on arrow keys (silently
    // changing the value) and Alt+Down opens the dropdown. Block both:
    // selects open via mouse / Enter / Space (see TvSelectDirective for
    // the styled picker variant); arrows are reserved for spatial nav.
    // If no neighbour exists, focus stays put — never a stray value
    // mutation from an arrow press.
    if (tag === 'SELECT') {
      e.preventDefault();
    }
    // Sliders (seekbar, volume) own ArrowLeft/Right for value adjustment —
    // never spatial-nav those. ArrowUp/Down on a horizontal slider has no
    // intrinsic meaning, so we let those bubble to the focus tree so the
    // user can escape vertically (out of the seekbar, into the controls
    // bar above or the content row below). Without this, the focus gets
    // trapped on the seekbar and the user has to back out of the player
    // to recover.
    if (active?.matches('[role="slider"], [data-tv-skip-spatial], [data-tv-skip-spatial] *')) {
      if (dir === 'left' || dir === 'right') return;
    }
    e.preventDefault();
    // crossZones = !e.repeat: a deliberate (non-repeat) press may leave the
    // current zone; a held key's repeats stay inside it.
    this.dispatchMove(dir, !e.repeat);
  }

  /** Pace focus moves: a held key or a fast double-tap can fire smooth scrolls
   *  faster than they settle, which judders. Leading + trailing — the first
   *  move runs now, any move within the window is coalesced into one trailing
   *  move at the window's end (latest direction wins), so no press is lost. */
  private dispatchMove(dir: 'left' | 'right' | 'up' | 'down', crossZones: boolean) {
    if (this.pendingNavTimer !== null) {
      this.pendingNavDir = dir;
      // A fresh press (repeat=false → crossZones true) mid-window re-enables
      // crossing for the trailing move; held repeats keep it false.
      this.pendingCrossZones ||= crossZones;
      return;
    }
    const wait = NAV_MIN_INTERVAL_MS - (Date.now() - this.lastNavAt);
    if (wait <= 0) {
      this.lastNavAt = Date.now();
      this.performMove(dir, crossZones);
      return;
    }
    this.pendingNavDir = dir;
    this.pendingCrossZones = crossZones;
    this.pendingNavTimer = setTimeout(() => {
      this.pendingNavTimer = null;
      this.lastNavAt = Date.now();
      this.performMove(this.pendingNavDir, this.pendingCrossZones);
    }, wait);
  }

  /** Move focus to the neighbour in `dir`, or scroll the page when none exists.
   *  `crossZones` false (a held key) keeps focus inside its current zone. */
  private performMove(dir: 'left' | 'right' | 'up' | 'down', crossZones: boolean) {
    const active = document.activeElement as HTMLElement | null;
    const next = this.findNeighbor(dir);
    if (next) {
      // Held key stays inside the current zone (a TV row, the library grid):
      // a deliberate press crosses out, a held one doesn't, so you can't
      // overshoot out of a row / grid by leaning on the D-pad.
      if (!crossZones && this.exitsZone(active, next)) return;
      // preventScroll keeps the browser's instant auto-scroll off; the smooth
      // scrollIntoView animates an off-screen card in (block:'nearest'), while
      // horizontal-scroller's focusin handler owns vertical row-top alignment.
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      return;
    }
    // No focusable neighbour: scroll the page so the user can reach info content
    // below the last card. Held keys stay put; up/down only; not in a modal.
    if (crossZones && !this.openModals().length && (dir === 'down' || dir === 'up')) {
      window.scrollBy({ top: dir === 'down' ? PAGE_SCROLL_AMOUNT_PX : -PAGE_SCROLL_AMOUNT_PX, behavior: 'smooth' });
    }
  }

  /** True when moving to `next` would leave the [data-tv-zone] that currently
   *  holds focus. Elements outside any zone never block. */
  private exitsZone(active: HTMLElement | null, next: HTMLElement): boolean {
    const zone = active?.closest('[data-tv-zone]');
    if (!zone) return false;
    return !zone.contains(next);
  }

  /** Accumulated wheel deltaY between focus-step emissions, so one notch
   *  (≈120) maps to exactly one up/down move regardless of the platform's
   *  delta granularity. */
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
      this.navigateVertical(dir);
    }
  }

  /** Magic-Remote wheel vertical step. Routes through the same paced dispatcher
   *  as the D-pad so a fast spin can't fire smooth scrolls faster than they
   *  settle. crossZones=true: a wheel is a scroll gesture, not a discrete press,
   *  so it may scroll out of a zone (unlike a held D-pad key). */
  private navigateVertical(dir: 'up' | 'down') {
    this.dispatchMove(dir, true);
  }

  /** Currently-open overlays that scope spatial navigation. Bottom sheets
   *  / popovers carry `[data-tv-modal]`; daisyUI dropdowns are detected
   *  via `.dropdown-open .dropdown-content` because their content stays
   *  in the DOM with `display:none` when closed (a bare attribute would
   *  falsely match). Native `<dialog>` elements opened via `showModal()`
   *  get the `open` attribute and are picked up here so arrow keys can't
   *  escape into the inert page underneath. */
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
    // Modal trap takes precedence over tree-aware. The dropdown / sheet
    // is a self-contained universe; walking up the container tree would
    // bridge to whatever sits behind it on the page (a dropdown rendered
    // inside the top-right cluster's [appTvRow] would otherwise let ↓
    // from its first item escape down into the page section below).
    // Prefer the modal that contains focus; fall back to the first open
    // one so a freshly-opened dropdown still scopes arrows even before
    // focus has settled inside it.
    const modals = this.openModals();
    // Flyout submenus (Corrections / Décalage) trap up/down inside themselves
    // so focus can't leak into the parent menu or the page behind. Left jumps
    // straight back to the opener the popover recorded (rect-nav would land on
    // whatever sits behind the flyout); right has nowhere to go.
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
      openModal = modals.length
        ? modals.find((m) => active && m.contains(active)) ?? modals[0]
        : null;
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

    // Scope horizontal nav to the active horizontal scroller (if any).
    // Without this, pressing Right on the last card of a row would fall
    // through to the `anywhere` fallback and land on a card from another
    // row. The restriction is applied below only to off-line / anywhere
    // candidates — in-line (same row) candidates are always considered
    // so the user can step out of the row toward a same-band element
    // outside it (typically: the layout sidebar on the left).
    const activeScroller = horizontal
      ? active.closest<HTMLElement>('.flex.overflow-x-auto, [data-scroller]')
      : null;

    // Three-pass selection:
    //   1. In-line: candidate's box overlaps the source's perpendicular axis
    //      (same row for horizontal nav, same column for vertical) → pick
    //      closest by primary distance. Matches user intent in 90% of cases.
    //   2. Off-line in 45° cone: nothing in the same row/col, take the
    //      closest candidate within 45° of the requested direction.
    //   3. Anything in the half-plane: last-resort fallback so the D-pad
    //      always finds *something* (e.g. reaching the top-left hamburger
    //      from a center button on a hero page would otherwise be stuck).
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
        // Same-band candidates are considered globally — this is what lets
        // Left from the leftmost card in a row reach the sidebar without
        // falling through to the cross-row `anywhere` fallback.
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

  /**
   * Tree-aware step. Climbs from the deepest container holding `active` and
   * at every level whose orientation matches the requested direction tries
   * to step to the next/prev sibling navigable child. If the climb hits the
   * tree root without matching, bridges to a peer top-level container in
   * the requested direction (rect-scored among peers only). Returns null
   * if neither path produces a target so the caller falls back to the
   * page-wide rect-based scoring.
   */
  private findNeighborInTree(active: HTMLElement, dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
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
            // A vertical step crosses into a different row: land on that row's
            // first item, not wherever focus last sat there. A horizontal step
            // walks to the literal sibling, so keep the leaf as-is.
            return this.digDown(children[nextIdx], !horizontal);
          }
        }
      }
      cur = cur.parent;
    }
    // No tree-step matched — bridge to a peer top-level container. Without
    // this, an arrow at the boundary of an isolated container (e.g. the
    // top-right user/cast row, which has no parent section) would always
    // fall through to rect-based and could pick a far-away leaf instead of
    // the next logical region.
    if (topMost) {
      const peer = this.findPeerContainer(topMost, dir);
      // Peer bridging only ever fires for up/down (see findPeerContainer), so
      // entering the peer region lands on its first item.
      if (peer) return this.digDown(peer.el, true);
    }
    return null;
  }

  /**
   * Pick the closest visible top-level container in the requested direction.
   *
   * Only fires for vertical directions: a layout often has overlapping
   * top-level regions on the same horizontal band (e.g. an absolutely
   * positioned top-right user/cast row floating over the page section
   * underneath), so an edge-based "left of" / "right of" test is ambiguous
   * — we leave horizontal bridging to the rect-based fallback. Vertical
   * direction is unambiguous: the user wants to step out of the current
   * region into the next-deeper region downward (or upward).
   */
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
      if (!isVisibleElement(c.el)) continue;
      const r = c.el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // Center-based + extent check: candidate's center is in the right
      // direction AND it extends past the source on that axis. Catches
      // overlapping regions (page section under a floating top bar) that
      // a strict edge check would miss.
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

  /**
   * Resolve a navigable child to a focusable leaf. When `preferFirst` is
   * false (horizontal entry), priority order:
   *   1. The container's remembered activeChild (last-focused memory).
   *   2. A descendant with the `autofocus` attribute — page authors mark
   *      the natural starting point (e.g. the "Reprendre" button on a
   *      detail page) with this, so on first entry we land directly there
   *      instead of crawling DOM-order to whichever focusable comes first.
   *   3. The first navigable child, recursed.
   * When `preferFirst` is true (vertical entry into a new row/region),
   * skip memory and autofocus and land on the first navigable child.
   */
  private digDown(el: HTMLElement, preferFirst = false): HTMLElement | null {
    const c = this.containers.get(el);
    if (!c) return el; // it's a leaf focusable
    if (!preferFirst && c.activeChild && c.el.contains(c.activeChild) && isVisibleFocusable(c.activeChild)) {
      return c.activeChild;
    }
    if (!preferFirst) {
      const auto = c.el.querySelector<HTMLElement>('[autofocus]');
      if (auto && isVisibleFocusable(auto)) return auto;
    }
    const children = this.getNavigableChildren(c);
    for (const child of children) {
      const dug = this.digDown(child, preferFirst);
      if (dug) return dug;
    }
    return null;
  }

  /**
   * The navigable children of a container are: its registered direct
   * sub-containers, plus the focusable leaves directly inside it that are
   * not hidden by a deeper container. Walk the DOM and cut at every
   * sub-container boundary so the tree-step doesn't see a sub-container's
   * inner cards as siblings.
   */
  private getNavigableChildren(container: ContainerNode): HTMLElement[] {
    const out: HTMLElement[] = [];
    const visit = (el: HTMLElement) => {
      // A registered sub-container: it is itself a navigable child; do not
      // descend (the recursion stops, its own children belong to its tree).
      if (el !== container.el && this.containers.has(el)) {
        if (isVisibleElement(el)) out.push(el);
        return;
      }
      // A focusable leaf at this level — treat as navigable, do not descend.
      if (matchesFocusable(el) && isVisibleFocusable(el)) {
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

function isVisibleElement(el: HTMLElement): boolean {
  if (el.offsetParent === null && el.tagName !== 'BODY') return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function isVisibleFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.getAttribute('tabindex') === '-1') return false;
  return isVisibleElement(el);
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
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // tabindex=-1 means "skip spatial nav". The FOCUSABLE_SELECTOR matches
    // anchors via `a[href]` independently of tabindex, so without this filter
    // a media-card's inner title/subtitle links (which we set tabindex=-1 on
    // TV) would still be picked up by the D-pad as separate focus targets.
    if (el.getAttribute('tabindex') === '-1') return false;
    // offsetParent is null when the element (or any ancestor) has display:none,
    // visibility:hidden, or is detached — covers the cases where a parent hides
    // a focusable child via class toggling without the child itself being hidden.
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    // Reject focusables only when they're positioned entirely off-document —
    // not just scrolled out of view. DaisyUI's drawer-toggle checkbox lives
    // at left: -100% and would otherwise pollute spatial nav (Left key would
    // teleport focus into it). But cards scrolled off a horizontal row, or
    // page sections scrolled above the viewport on a long detail page, are
    // valid targets: focusing them makes the browser scroll them back into
    // view. Document coords (viewport rect + window scroll) stay positive
    // for scrolled-off content, and a horizontal-scroller's internal
    // scrollLeft reaches its hidden siblings, so allow either case.
    if (r.right <= 0 || r.bottom <= 0) {
      const inScroller = el.closest('.flex.overflow-x-auto, [data-scroller]');
      const docRight = r.right + window.scrollX;
      const docBottom = r.bottom + window.scrollY;
      if (!inScroller && (docRight <= 0 || docBottom <= 0)) return false;
    }
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    // pointerEvents:none folded in here (the scoring loop used to call
    // getComputedStyle a second time per element for this) — reuses the style
    // object already resolved above, so it's free, and the result is cached.
    if (style.pointerEvents === 'none') return false;
    return true;
  });
  // Keep only the outermost focusables: if an element has an ancestor that is
  // also focusable, treat the ancestor as the navigation target. Without this,
  // a card containing several inner buttons/links presents 5+ targets to spatial
  // nav and a "Right" key can land on an inner element instead of the next card.
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
