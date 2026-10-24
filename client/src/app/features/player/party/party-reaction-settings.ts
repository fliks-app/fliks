import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MAX_BAR } from '../../../core/services/party/reaction-bar';
import { ReactionCatalogService } from '../../../core/services/party/reaction-catalog.service';
import { PartyService } from '../../../core/services/party/party.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';

/** Reaction settings, opened from the player's top-bar reaction button; lives in the player so it shows in fullscreen. */
@Component({
  selector: 'app-party-reaction-settings',
  imports: [TranslatePipe, ModalHeaderComponent, ToggleFieldComponent],
  templateUrl: './party-reaction-settings.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyReactionSettingsComponent {
  protected readonly party = inject(PartyService);
  protected readonly catalog = inject(ReactionCatalogService);
  protected readonly max = MAX_BAR;
  /** Set when a tap was refused because the bar is full. */
  protected readonly full = signal(false);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected toggle(emoji: string): void {
    const ok = this.catalog.toggle(emoji);
    this.full.set(!ok && !this.catalog.bar().includes(emoji));
  }

  protected reset(): void {
    this.catalog.reset();
    this.full.set(false);
  }

  show(): void {
    void this.catalog.load();
    this.dialog().nativeElement.showModal();
  }
}
