import { classUntilDone, markViewTransition } from './view-transition';

/** Descendants carrying the same key on both sides of a morph travel on their own (a cover, a title). */
const PART_ATTR = 'data-morph';
/** Blocks that keep their identity across a relayout. */
const BLOCK_ATTR = 'data-relayout';

export interface Morph {
  /** The element on screen now, e.g. the trigger a dialog opens out of. */
  from: HTMLElement | null;
  /** Applies the change and returns the element that replaces `from`; the new state is captured once it settles. */
  update: () => HTMLElement | null | Promise<HTMLElement | null>;
  /** A layer that fades with the change, e.g. the dialog that dims the page. */
  scrim?: HTMLElement | null;
}

/** Elements named, or hidden, by the transition in flight; a newer one takes them over. */
const named = new Set<HTMLElement>();
const hidden = new Set<HTMLElement>();
let active: object | null = null;

export function canMorph(): boolean {
  return (
    typeof document !== 'undefined' &&
    !!document.startViewTransition &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches &&
    !document.body.classList.contains('reduced-effects')
  );
}

/**
 * Container transform: `from` turns into what `update` returns. The box moves between the two rects while both states
 * dissolve on it, and the page is final before anything moves. Without support it only updates.
 */
export function morph({ from, update, scrim }: Morph): void {
  if (!from || !canMorph()) {
    void update();
    return;
  }
  const token = begin();
  if (scrim) name(scrim, 'vt-morph-scrim', 'morph-scrim');
  const leaving = tag(from, 'from');
  const keys = new Set(leaving.map((el) => el.getAttribute(PART_ATTR)));
  run(token, 'vt-morph', async () => {
    leaving.forEach(unname);
    const to = await update();
    // The new state is captured live: an exit animation that still holds `from` in the DOM, or an entry one, would show in it.
    if (from !== to && from.isConnected) hide(from);
    [scrim, to].forEach((el) => el && settleAnimations(el));
    if (to) tag(to, 'to', keys);
  });
}

/**
 * Layout change inside `scope`: its `[data-relayout]` blocks slide from their old box to their new one, cropped at their
 * own size rather than scaled, and fade when only one side has them. Everything else swaps at once.
 */
export function relayout(scope: HTMLElement | null, update: () => void | Promise<void>): void {
  if (!scope || !canMorph()) {
    void update();
    return;
  }
  const token = begin();
  const mark = () =>
    scope.querySelectorAll<HTMLElement>(`[${BLOCK_ATTR}]`).forEach((el) => name(el, `vt-relayout-${el.getAttribute(BLOCK_ATTR)}`, 'relayout'));
  mark();
  run(token, 'vt-relayout', async () => {
    await update();
    settleAnimations(scope);
    mark();
  });
}

function begin(): object {
  release();
  const token = {};
  active = token;
  return token;
}

function run(token: object, cls: string, update: () => Promise<void>): void {
  const transition = document.startViewTransition(update);
  classUntilDone(transition, cls);
  markViewTransition(transition);
  const done = () => {
    if (active === token) release();
  };
  void transition.finished.then(done, done);
}

/** Names a morph container and its keyed parts, only those `keys` lists when given; returns what it named. */
function tag(container: HTMLElement, side: 'from' | 'to', keys?: Set<string | null>): HTMLElement[] {
  document.documentElement.style.setProperty(`--vt-morph-${side}-radius`, getComputedStyle(container).borderTopLeftRadius);
  const parts = [...container.querySelectorAll<HTMLElement>(`[${PART_ATTR}]`)].filter((p) => !keys || keys.has(p.getAttribute(PART_ATTR)));
  name(container, 'vt-morph', 'morph');
  parts.forEach((p) => name(p, `vt-morph-${p.getAttribute(PART_ATTR)}`, 'morph-part'));
  return [container, ...parts];
}

function name(el: HTMLElement, value: string, cls: string): void {
  el.style.setProperty('view-transition-name', value, 'important');
  el.style.setProperty('view-transition-class', cls);
  named.add(el);
}

function unname(el: HTMLElement): void {
  el.style.removeProperty('view-transition-name');
  el.style.removeProperty('view-transition-class');
  named.delete(el);
}

function hide(el: HTMLElement): void {
  el.style.setProperty('visibility', 'hidden');
  hidden.add(el);
}

function release(): void {
  named.forEach(unname);
  hidden.forEach((el) => el.style.removeProperty('visibility'));
  hidden.clear();
  const root = document.documentElement.style;
  root.removeProperty('--vt-morph-from-radius');
  root.removeProperty('--vt-morph-to-radius');
  active = null;
}

/** Jumps finite animations and transitions in `el` to their end; an endless one (a marquee) has no end to reach. */
function settleAnimations(el: HTMLElement): void {
  for (const a of el.getAnimations({ subtree: true })) {
    if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
  }
}
