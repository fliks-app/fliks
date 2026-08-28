import { Directive, computed, input, signal } from '@angular/core';

/**
 * Masks spoiler-bearing content (an unwatched episode's still or synopsis)
 * behind a blur until the user asks for it — click or Enter reveals it for the
 * life of the view. The reveal click is swallowed so it can't also trigger the
 * play/open handler of an enclosing card.
 *
 * Usage:
 *   <p [appSpoiler]="masked" #sp="spoiler">{{ overview }}</p>
 */
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
