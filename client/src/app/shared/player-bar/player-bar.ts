import { Component, computed, inject, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucidePause, LucidePlay } from '@lucide/angular';
import { FullPlayerState } from '../../core/services/playback/full-player-state';
import { TvRowDirective } from '../directives/tv-row.directive';
import type { MediaFamily } from '../../core/media-kinds';

/**
 * The now-playing bar over the page, whatever plays: this device, a parked session, another device, a cast.
 * Content projects into `[barCover]`, the default slot (the lines) and `[barActions]`.
 */
@Component({
  selector: 'app-player-bar',
  imports: [TranslatePipe, LucidePause, LucidePlay, TvRowDirective],
  styles: [':host { display: contents; }'],
  templateUrl: './player-bar.html',
})
export class PlayerBarComponent {
  private readonly fullPlayer = inject(FullPlayerState);

  /** The full player the bar opens: that player morphs out of it and stands in for it until it closes. */
  readonly opens = input<MediaFamily | null>(null);
  readonly openLabel = input('');
  readonly openDisabled = input(false);
  /** Null drops the play/pause button. */
  readonly playing = input<boolean | null>(null);
  /** Played share of the item, 0 to 100; null drops the progress line. */
  readonly percent = input<number | null>(null);
  /** Background picked from the artwork. */
  readonly tint = input<string | null>(null);
  /** Stacks the bar above another one in the same slot. */
  readonly raised = input(false);
  /** Dims the bar while what it shows is being synced. */
  readonly busy = input(false);

  readonly opened = output<void>();
  readonly toggled = output<void>();

  /** Hidden, not unmounted, while its player stands in for it: put back, its content would replay its entry animations. */
  protected readonly visible = computed(() => !this.opens() || this.fullPlayer.presented() !== this.opens());
}
