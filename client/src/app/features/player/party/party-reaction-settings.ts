import { CdkDrag, CdkDragPlaceholder, CdkDropList } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideSearch, LucideX } from '@lucide/angular';
import { EmojiDataService } from '../../../core/services/party/emoji-data.service';
import { MAX_BAR } from '../../../core/services/party/reaction-bar';
import { PartyService } from '../../../core/services/party/party.service';
import { ReactionsService } from '../../../core/services/party/reactions.service';
import { DeviceService } from '../../../core/services/device.service';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';

interface Section {
  key: string;
  /** Already-localized header (emoji group), or the i18n key of one of ours; none for search results. */
  label?: string;
  labelKey?: string;
  emojis: string[];
}

/** Reaction settings, opened from the player's settings menu; lives in the player so it shows in fullscreen. */
@Component({
  selector: 'app-party-reaction-settings',
  imports: [FormsModule, NgTemplateOutlet, CdkDropList, CdkDrag, CdkDragPlaceholder, TranslatePipe, LucideSearch, LucideX, ModalHeaderComponent, ToggleFieldComponent],
  templateUrl: './party-reaction-settings.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyReactionSettingsComponent {
  protected readonly reactions = inject(ReactionsService);
  protected readonly party = inject(PartyService);
  protected readonly data = inject(EmojiDataService);
  protected readonly keyboard = inject(KeyboardOverlayService);
  protected readonly skeletonCells = Array.from({ length: 30 }, (_, i) => i);
  protected readonly isTv = inject(DeviceService).isTv;
  protected readonly max = MAX_BAR;
  protected readonly query = signal('');
  /** Set when a tap was refused because the bar is full. */
  protected readonly full = signal(false);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  /** The player mounts the dialog to open it and drops it on close. */
  readonly closed = output<void>();

  constructor() {
    afterNextRender(() => {
      void this.reactions.load();
      void this.data.load();
      this.dialog().nativeElement.showModal();
    });
  }

  protected readonly searching = computed(() => this.query().trim() !== '');
  protected readonly sections = computed<Section[]>(() => {
    if (this.searching()) return [{ key: 'results', emojis: this.data.search(this.query()).map((e) => e.emoji) }];
    const groups = this.data.groups();
    const animated = groups.flatMap((g) => g.emojis.map((e) => e.emoji)).filter((e) => this.reactions.animation(e) !== null);
    return [
      { key: 'bar', labelKey: 'party.reaction_section_bar', emojis: this.reactions.bar() },
      { key: 'animated', labelKey: 'party.reaction_section_animated', emojis: animated },
      ...groups.map((g) => ({ key: g.key, label: g.label, emojis: g.emojis.map((e) => e.emoji) })),
    ];
  });

  protected toggle(emoji: string): void {
    const ok = this.reactions.toggle(emoji);
    this.full.set(!ok && !this.reactions.bar().includes(emoji));
  }

  protected reset(): void {
    this.reactions.reset();
    this.full.set(false);
  }

}
