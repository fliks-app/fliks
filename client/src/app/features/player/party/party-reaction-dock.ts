import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideSmilePlus, LucideX } from '@lucide/angular';
import { DismissableStackService } from '../../../core/services/dismissable-stack.service';
import { ReactionsService } from '../../../core/services/party/reactions.service';
import { PartyService } from '../../../core/services/party/party.service';
import { TvRowDirective } from '../../../shared/directives/tv-row.directive';

const POP_MS = 220;

/** Reaction button of the player's action strip: opens a row of emojis to its left, one tap sends (and folds it back, per the reaction settings). */
@Component({
  selector: 'app-party-reaction-dock',
  imports: [TranslatePipe, LucideSmilePlus, LucideX, TvRowDirective],
  templateUrl: './party-reaction-dock.html',
  styleUrl: './party-reaction-dock.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The player wakes its controls on any click or pointer move; the dock is used without them.
  host: { '(click)': '$event.stopPropagation()', '(mousemove)': '$event.stopPropagation()' },
})
export class PartyReactionDockComponent {
  private readonly party = inject(PartyService);
  protected readonly reactions = inject(ReactionsService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly toggleBtn = viewChild.required<ElementRef<HTMLButtonElement>>('toggle');
  readonly open = this.reactions.rowOpen.asReadonly();

  constructor() {
    // Back folds the row before anything else, like the player's other menus.
    effect((onCleanup) => {
      if (!this.open()) return;
      const fold = () => this.fold();
      this.dismissStack.push(fold);
      onCleanup(() => this.dismissStack.remove(fold));
    });
  }

  protected send(emoji: string, event: Event): void {
    this.party.react(emoji);
    const pop = (event.currentTarget as HTMLElement).animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }, { transform: 'scale(1)' }],
      { duration: POP_MS, easing: 'ease-out' },
    );
    // The row folds once the tapped emoji has finished its pop, or the feedback is never seen.
    if (!this.reactions.keepOpen()) pop.finished.then(() => this.fold(), () => this.fold());
  }

  /** Focus returns to the button when it sat on an emoji, which leaves the D-pad order as the row folds. */
  protected fold(): void {
    const btn = this.toggleBtn().nativeElement;
    const inRow = !!document.activeElement?.closest('.emojis');
    this.reactions.setRowOpen(false);
    if (inRow) btn.focus({ preventScroll: true });
  }
}
