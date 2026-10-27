export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Each `[data-row]` element's top under `root`, keyed by its `data-row`. */
export function rowTops(root: HTMLElement): Map<string, number> {
  const tops = new Map<string, number>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-row]')) tops.set(el.dataset['row']!, el.getBoundingClientRect().top);
  return tops;
}

/** FLIP: a row that moved since `before` slides from its old place instead of jumping. */
export function slideRows(root: HTMLElement, before: Map<string, number>): void {
  if (reducedMotion()) return;
  for (const el of root.querySelectorAll<HTMLElement>('[data-row]')) {
    const old = before.get(el.dataset['row']!);
    const dy = old === undefined ? 0 : old - el.getBoundingClientRect().top;
    if (dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 250, easing: 'ease-out' });
  }
}
