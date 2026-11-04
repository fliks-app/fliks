/** The page whose slot (`[data-page]`) is under the top third of a scroller: the last one that starts above that line. */
export function pageAtProbe(root: HTMLElement): number {
  const probe = root.getBoundingClientRect().top + root.clientHeight / 3;
  const slots = Array.from(root.querySelectorAll<HTMLElement>('[data-page]'));
  const hit = slots.filter((s) => s.getBoundingClientRect().top <= probe).pop() ?? slots[0];
  return Number(hit?.dataset['page'] ?? 1);
}

export function scrollToPageSlot(root: HTMLElement, n: number): void {
  root.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: 'start' });
}
