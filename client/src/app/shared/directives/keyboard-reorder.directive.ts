import { Directive, ElementRef, Injector, afterNextRender, booleanAttribute, inject, input, output, signal } from '@angular/core';

const HELD_CLASS = 'reorder-held';
const SLIDE_MS = 180;

/** Keyboard (and D-pad) reordering for a horizontal list, next to the CDK drag-drop that only knows pointers.
 *  Enter on an item `[data-reorder-item]` picks it up, ←/→ move it, past the last one arms the trash (when `removable`),
 *  Enter drops (or removes over the trash). `exportAs: 'reorder'` exposes the state to the template. */
@Directive({
  selector: '[appKeyboardReorder]',
  standalone: true,
  exportAs: 'reorder',
  host: { '(keydown)': 'onKey($event)', '(focusout)': 'onFocusOut($event)' },
})
export class KeyboardReorderDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Number of items in the list. */
  readonly count = input.required<number>({ alias: 'appKeyboardReorder' });
  /** Moving past the last item arms a trash that Enter empties. */
  readonly removable = input(false, { transform: booleanAttribute });
  readonly moved = output<{ from: number; to: number }>();
  readonly removed = output<number>();

  /** The held item's index, null when nothing is held. */
  readonly index = signal<number | null>(null);
  readonly overTrash = signal(false);
  /** The list is re-rendering a move: moving the focused node in the DOM blurs it, which is not a leave. */
  private moving = false;

  protected onKey(e: KeyboardEvent): void {
    const held = this.index();
    const items = this.items();
    if (held === null) {
      const at = items.indexOf((e.target as HTMLElement).closest<HTMLElement>('[data-reorder-item]')!);
      if (e.key !== 'Enter' || at < 0) return;
      this.index.set(at);
      this.mark(items[at]);
    } else if (e.key === 'ArrowLeft') {
      if (this.overTrash()) this.overTrash.set(false);
      else if (held > 0) this.moveTo(held - 1);
    } else if (e.key === 'ArrowRight') {
      if (held < this.count() - 1) this.moveTo(held + 1);
      else if (this.removable()) this.overTrash.set(true);
    } else if (e.key === 'Enter') {
      const removing = this.overTrash();
      if (removing) this.removed.emit(held);
      this.release();
      if (removing) this.focusAfterRemoval(held);
    } else if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
      return;
    }
    // Held, every arrow belongs here: the spatial nav and the page must not move focus or seek.
    e.preventDefault();
    e.stopPropagation();
  }

  /** Focus leaving the list (a click elsewhere, a tab out) drops the item where it is. */
  protected onFocusOut(e: FocusEvent): void {
    if (this.moving || this.index() === null) return;
    if (!this.host.nativeElement.contains(e.relatedTarget as Node | null)) this.release();
  }

  private moveTo(to: number): void {
    const before = new Map(this.items().map((el) => [el, el.getBoundingClientRect().left]));
    this.moved.emit({ from: this.index()!, to });
    this.index.set(to);
    this.moving = true;
    // The list re-renders in its new order; keep the held item marked and focused, and slide the swapped items.
    afterNextRender(
      () => {
        this.moving = false;
        const items = this.items();
        this.mark(items[to]);
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        for (const el of items) {
          const dx = (before.get(el) ?? 0) - el.getBoundingClientRect().left;
          if (dx) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: 'ease-out' });
        }
      },
      { injector: this.injector },
    );
  }

  /** The removed item took the focus with it: hand it to the item that took its place, or the new last one. */
  private focusAfterRemoval(at: number): void {
    afterNextRender(
      () => {
        const items = this.items();
        const item = items[Math.min(at, items.length - 1)];
        (item?.matches('button, [tabindex]') ? item : item?.querySelector<HTMLElement>('button, [tabindex]'))?.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  private release(): void {
    this.index.set(null);
    this.overTrash.set(false);
    for (const el of this.items()) this.unmark(el);
  }

  private items(): HTMLElement[] {
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-reorder-item]'));
  }

  private mark(item: HTMLElement | undefined): void {
    for (const el of this.items()) if (el !== item) this.unmark(el);
    if (!item) return;
    item.classList.add(HELD_CLASS);
    const target = item.matches('button, [tabindex]') ? item : item.querySelector<HTMLElement>('button, [tabindex]');
    // The spatial nav leaves arrows alone on these, so they reach this directive.
    target?.setAttribute('data-tv-skip-spatial', '');
    target?.setAttribute('data-tv-own-vertical', '');
    target?.focus({ preventScroll: true });
  }

  private unmark(item: HTMLElement): void {
    item.classList.remove(HELD_CLASS);
    item.querySelectorAll('[data-tv-skip-spatial]').forEach((el) => el.removeAttribute('data-tv-skip-spatial'));
    item.querySelectorAll('[data-tv-own-vertical]').forEach((el) => el.removeAttribute('data-tv-own-vertical'));
    item.removeAttribute('data-tv-skip-spatial');
    item.removeAttribute('data-tv-own-vertical');
  }
}
