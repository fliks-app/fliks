import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { ReactionsService } from '../../../core/services/party/reactions.service';

/** A reaction as its animated image; the text glyph when it has none or the image fails. */
@Component({
  selector: 'app-party-emoji',
  templateUrl: './party-emoji.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block h-[1em] w-[1em] leading-none' },
})
export class PartyEmojiComponent {
  readonly emoji = input.required<string>();
  protected readonly failed = signal(false);
  protected readonly src = computed(() => (this.failed() ? null : this.reactions.animation(this.emoji())));
  private readonly reactions = inject(ReactionsService);
}
