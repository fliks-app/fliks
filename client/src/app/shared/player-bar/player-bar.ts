import { Component, TemplateRef, computed, effect, inject, input, output, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../icons';
import { FullPlayerState } from '../../core/services/playback/full-player-state';
import { DeviceService } from '../../core/services/device.service';
import { NavbarService } from '../../core/services/navbar.service';
import { TvRowDirective } from '../directives/tv-row.directive';
import type { MediaFamily } from '../../core/media-kinds';

/**
 * The now-playing bar over the page, whatever plays: this device, a parked session, another device, a cast.
 * Content projects into `[barCover]`, the default slot (the lines) and `[barActions]`.
 */
@Component({
  selector: 'app-player-bar',
  imports: [NgTemplateOutlet, TranslatePipe, TvRowDirective, LucideDynamicIcon],
  styles: [':host { display: contents; }'],
  templateUrl: './player-bar.html',
})
export class PlayerBarComponent {
  protected readonly icons = icons;

  private readonly fullPlayer = inject(FullPlayerState);
  private readonly navbar = inject(NavbarService);
  /** On TV the bar sits in the navbar, one ↑ from the page. */
  protected readonly docked = inject(DeviceService).isTv();
  private readonly bar = viewChild.required<TemplateRef<unknown>>('bar');

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

  constructor() {
    if (!this.docked) return;
    effect((onCleanup) => {
      const bar = this.bar();
      this.navbar.tvBars.update((bars) => [...bars, bar]);
      onCleanup(() => this.navbar.tvBars.update((bars) => bars.filter((b) => b !== bar)));
    });
  }
}
