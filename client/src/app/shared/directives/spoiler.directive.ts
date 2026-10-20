import { Directive, computed, input, signal } from '@angular/core';

/** Masks spoiler content behind a blur until click/Enter reveals it for the view; the reveal click is swallowed so an enclosing card's handler doesn't fire.
 *  Usage: `<p [appSpoiler]="masked" #sp="spoiler">`. */
@Directive({
  selector: '[appSpoiler]',
  standalone: true,
  exportAs: 'spoiler',
  host: {
    // `transition` covers filter, so the blur eases out on reveal.
    class: 'transition duration-300 ease-out',
    '[class.blur-lg]': 'masked() && !soft()',
    '[class.blur-sm]': 'masked() && soft()',
    '[class.cursor-pointer]': 'masked()',
    '[class.select-none]': 'masked()',
    '[attr.role]': 'masked() ? "button" : null',
    '[attr.tabindex]': 'masked() ? 0 : null',
    '[attr.aria-label]': 'masked() ? (revealLabel() || null) : null',
    '(click)': 'reveal($event)',
    '(keydown.enter)': 'reveal($event)',
  },
})
export class SpoilerDirective {
  readonly active = input(false, { alias: 'appSpoiler' });
  readonly revealLabel = input('');
  /** Lighter blur — enough to make text unreadable without turning it to soup. */
  readonly soft = input(false);

  private readonly revealed = signal(false);
  readonly masked = computed(() => this.active() && !this.revealed());

  reveal(event: Event): void {
    if (!this.masked()) return;
    event.stopPropagation();
    event.preventDefault();
    this.revealed.set(true);
  }
}
