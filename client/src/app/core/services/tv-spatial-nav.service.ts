import { Injectable, inject, DestroyRef, effect } from '@angular/core';
import { TvService } from './tv.service';

/**
 * Spatial navigation for D-pad input on Android TV.
 *
 * Two cooperating layers:
 *
 * 1. **Container tree** (opt-in) — pages annotate sections with
 *    `[appTvSection]` (vertical) / `[appTvRow]` (horizontal). Each
 *    directive registers its element here, building a logical tree that
 *    groups focusables by intent. Within an annotated zone the focus
 *    walks the tree (last-active child memorised per container), so
 *    `↓` from the bottom-right card always lands on the next row's
 *    last-focused card — never on a sibling that just happens to be
 *    geometrically closer.
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

@Injectable({ providedIn: 'root' })
export class TvSpatialNavService {
  private readonly tv = inject(TvService);
  private readonly destroyRef = inject(DestroyRef);
  private bound = false;
  /** Registered containers, keyed by their host element. */
  private readonly containers = new Map<HTMLElement, ContainerNode>();

  constructor() {
    // Use an effect so we react to isTv flipping later (e.g. when TvService is
    // instantiated after us, or if detection is updated post-bootstrap).
    effect(() => {
      if (this.tv.isTv() && !this.bound) this.bind();
    });
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
    // Track the deepest focused element inside each registered container so
    // re-entering a container can dig back to the same leaf (last-active-child
    // memory). Bubble phase is fine: focusin always reaches the document.
    const focusInHandler = (e: FocusEvent) => this.updateActiveChild(e.target as HTMLElement | null);
    document.addEventListener('focusin', focusInHandler);
    this.destroyRef.onDestroy(() => document.removeEventListener('focusin', focusInHandler));
    // Android TV WebView often leaves the body un-focused on first paint, which
    // means D-pad events are consumed by the native View and never reach JS.
    // Pushing focus to the first interactive element guarantees subsequent
    // keydowns are dispatched into our handler.
    queueMicrotask(() => this.focusFirstIfNoFocus());
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

  private focusFirstIfNoFocus() {
    if (typeof document === 'undefined') return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const all = collectFocusables();
    all[0]?.focus({ preventScroll: true });
  }

  private onKey(e: KeyboardEvent) {
    // Some Android WebView builds don't report a `key` for D-pad events but
    // still ship `keyCode` 37/38/39/40 — accept either form.
    const dir = ARROW_TO_DIR[e.key] ?? KEYCODE_TO_DIR[e.keyCode];
    if (!dir) return;
    // Skip if focus is inside a text-style input, a <select>, or its
    // open-picker option — they own arrow-key handling natively (caret
    // movement / option cycling). Checkbox/radio/range have no caret, so
    // spatial nav keeps handling them.
    const active = document.activeElement as HTMLElement | null;
    const tag = active?.tagName;
    const inputType = (active as HTMLInputElement | null)?.type;
    const isSingleLineTextInput =
      tag === 'INPUT' &&
      !['checkbox', 'radio', 'range', 'button', 'submit', 'reset'].includes(inputType ?? '');
    const isMultiLineText = tag === 'TEXTAREA' || tag === 'OPTION' || !!active?.isContentEditable;
    // Single-line text inputs only have a horizontal caret — left/right belong
    // to the field, but up/down should escape to the spatial-nav tree so D-pad
    // users on TV aren't trapped on the input.
    if (isSingleLineTextInput && (dir === 'left' || dir === 'right')) return;
    if (isMultiLineText) return;
    // Native `<select>` cycles its options on arrow keys (changing the
    // value silently). Always block that. We still try to move focus —
    // if a tree-aware neighbour exists, the user goes there; otherwise
    // we preventDefault below and the focus stays put. Either way, the
    // value of the select isn't mutated by a stray arrow press.
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
    const next = this.findNeighbor(dir);
    e.preventDefault();
    if (next) {
      next.focus({ preventScroll: false });
      return;
    }
    // No focusable neighbour: scroll the page manually so the user can
    // reach informational content (file infos, descriptions, etc.) that
    // sits below the last focusable card. Up/down only — left/right at a
    // boundary should just block (intra-row).
    if (dir === 'down' || dir === 'up') {
      window.scrollBy({ top: dir === 'down' ? 300 : -300, behavior: 'smooth' });
    }
  }

  private findNeighbor(dir: 'left' | 'right' | 'up' | 'down'): HTMLElement | null {
    const active = document.activeElement as HTMLElement | null;
    // Tree-aware path runs first: if the active element sits inside a
    // registered container, walk the logical tree (orientation-aware,
    // last-active-child memorised). Returning the rect-based fallback only
    // when the tree has nothing to say keeps unmigrated pages working
    // exactly as before.
    if (active && active !== document.body && this.containers.size > 0) {
      const tree = this.findNeighborInTree(active, dir);
      if (tree) return tree;
    }
    // Focus trap: any open dropdown/menu/bottom-sheet that opts in via
    // `[data-tv-modal]` (or `.dropdown-open .dropdown-content` for the
    // legacy player dropdowns) restricts navigation to its contents so
    // D-pad keys can't escape the modal.
    const openModal =
      document.querySelector<HTMLElement>('[data-tv-modal]') ??
      document.querySelector<HTMLElement>('.dropdown-open .dropdown-content');
    const all = openModal ? collectFocusables(openModal) : collectFocusables();
    if (!all.length) return null;

    if (!active || active === document.body) {
      return all[0] ?? null;
    }

    const fromRect = active.getBoundingClientRect();
    const fromCx = fromRect.left + fromRect.width / 2;
    const fromCy = fromRect.top + fromRect.height / 2;
    const horizontal = dir === 'left' || dir === 'right';

    // Scope horizontal nav to the active horizontal scroller (if any). Without
    // this, pressing Right on the last card of a row would fall through to
    // the `anywhere` fallback and land on a card from another row or a button
    // elsewhere. Inside a scroller, Left/Right should stay among siblings;
    // boundaries (first/last card) just block.
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
      // Horizontal nav inside a scroller: candidates must be siblings in the
      // same scroller. At the last/first card the loop yields no candidates
      // and findNeighbor returns null — D-pad Right at end-of-row blocks
      // (no jump to a button on another row), matching TV remote convention.
      if (activeScroller && !activeScroller.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(el).pointerEvents === 'none') continue;

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
        inLine.push({ el, primary });
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
            return this.digDown(children[nextIdx]);
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
      if (peer) return this.digDown(peer.el);
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
   * Resolve a navigable child to a focusable leaf. Priority order:
   *   1. The container's remembered activeChild (last-focused memory).
   *   2. A descendant with the `autofocus` attribute — page authors mark
   *      the natural starting point (e.g. the "Reprendre" button on a
   *      detail page) with this, so on first entry we land directly there
   *      instead of crawling DOM-order to whichever focusable comes first.
   *   3. The first navigable child, recursed.
   */
  private digDown(el: HTMLElement): HTMLElement | null {
    const c = this.containers.get(el);
    if (!c) return el; // it's a leaf focusable
    if (c.activeChild && c.el.contains(c.activeChild) && isVisibleFocusable(c.activeChild)) {
      return c.activeChild;
    }
    const auto = c.el.querySelector<HTMLElement>('[autofocus]');
    if (auto && isVisibleFocusable(auto)) return auto;
    const children = this.getNavigableChildren(c);
    for (const child of children) {
      const dug = this.digDown(child);
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

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [data-tv-focusable]';

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
