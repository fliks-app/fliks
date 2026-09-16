import { Component, OnDestroy, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LiveTvHealthComponent } from './health/live-tv-health';
import { LiveTvAvailabilityService } from '../../../core/services/live-tv-availability.service';

@Component({
  selector: 'app-live-tv-settings-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TranslatePipe, LiveTvHealthComponent],
  templateUrl: './live-tv-settings-shell.html',
})
export class LiveTvSettingsShellComponent implements OnDestroy {
  private readonly availability = inject(LiveTvAvailabilityService);
  /** Health has no route of its own (routing is owned elsewhere): a local
   *  tab that swaps in place of the router outlet instead. */
  readonly showHealth = signal(false);

  /** Sources and channels changed under these pages: the nav entry follows. */
  ngOnDestroy(): void {
    void this.availability.refresh();
  }
}
