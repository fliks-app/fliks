import { Injectable, signal } from '@angular/core';

/** What "Optimize…" acts on: whole titles, or only some episodes of one series (a season). */
export interface OptimizeModalConfig {
  title: string;
  mediaIds: number[];
  episodeIds?: number[];
}

/** App-wide broker for the optimize dialog, shaped like {@link IdentifyModalService}: one layout modal opened from detail or collection menus. */
@Injectable({ providedIn: 'root' })
export class OptimizeModalService {
  private counter = 0;
  readonly request = signal<{ config: OptimizeModalConfig; n: number } | null>(null);

  open(config: OptimizeModalConfig): void {
    this.request.set({ config, n: ++this.counter });
  }

  clear(): void {
    this.request.set(null);
  }
}
