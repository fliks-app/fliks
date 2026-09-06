import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { AuthService } from './auth.service';

/**
 * Account-level anti-spoiler preferences, resolved per episode. Each method
 * answers "does this element need masking for an episode in that watched
 * state" — the master switch plus the per-element opt-out.
 */
@Injectable({ providedIn: 'root' })
export class SpoilerService {
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);

  private on(watched: boolean): boolean {
    return (this.auth.user()?.hideSpoilers ?? false) && !watched;
  }

  still(watched: boolean): boolean {
    return this.on(watched) && (this.auth.user()?.spoilerHideStills ?? true);
  }

  overview(watched: boolean): boolean {
    return this.on(watched) && (this.auth.user()?.spoilerHideOverviews ?? true);
  }

  /** Episode name, swapped for `Episode 3` while it would spoil or when the episode has none. */
  title(watched: boolean, number: string, title: string | null): string {
    if (this.on(watched) && (this.auth.user()?.spoilerHideTitles ?? true)) {
      return this.translate.instant('spoilers.episode_title', { number });
    }
    return title || this.translate.instant('spoilers.episode_title', { number });
  }
}
