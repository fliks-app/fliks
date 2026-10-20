import { Injectable, signal } from '@angular/core';
import type { IdentifyModalConfig } from '../../features/media-detail/components/media-detail-identify-modal/media-detail-identify-modal.component';

/** App-wide broker for the identify dialog, shaped like {@link RecommendService}/{@link TrackingModalService}: one layout modal opened from detail or card menus. */
@Injectable({ providedIn: 'root' })
export class IdentifyModalService {
  private counter = 0;
  readonly request = signal<{ config: IdentifyModalConfig; n: number } | null>(null);
  /** Raised after a successful re-identification so the opener can reload. */
  readonly identified = signal(0);

  open(config: IdentifyModalConfig): void {
    this.request.set({ config, n: ++this.counter });
  }

  clear(): void {
    this.request.set(null);
  }

  markIdentified(): void {
    this.identified.update((n) => n + 1);
  }
}
