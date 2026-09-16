import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from './auth.service';
import { LiveTvApiService } from './api/livetv-api.service';

/** Whether Live TV has anything to show the signed-in user. Every nav surface
 *  reads it through the `liveTv` when-predicate, so the entry appears nowhere
 *  until a lineup exists. */
@Injectable({ providedIn: 'root' })
export class LiveTvAvailabilityService {
  private readonly api = inject(LiveTvApiService);
  private readonly auth = inject(AuthService);
  private readonly _available = signal(false);
  readonly available = this._available.asReadonly();

  private readonly onUser = effect(() => {
    if (this.auth.user()) untracked(() => void this.refresh());
    else this._available.set(false);
  });

  /** Re-asked when leaving the Live TV admin pages, where the lineup changes. */
  async refresh(): Promise<void> {
    try {
      this._available.set((await this.api.getStatus()).available);
    } catch (err) {
      console.warn('[live-tv] status unavailable, hiding the entry', err);
      this._available.set(false);
    }
  }
}
