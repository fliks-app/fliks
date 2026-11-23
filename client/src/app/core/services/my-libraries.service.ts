import { Injectable, inject, signal } from '@angular/core';
import { LibrariesApiService, type LibrarySummary } from './api/libraries-api.service';

/** The signed-in user's libraries for the nav: restored from the request cache before the first paint, then refreshed. */
@Injectable({ providedIn: 'root' })
export class MyLibrariesService {
  private readonly api = inject(LibrariesApiService);

  readonly list = signal<LibrarySummary[]>([]);
  /** False until a list is known: inserted under painted items, it would push them down. */
  readonly loaded = signal(false);

  async restore(): Promise<void> {
    const cached = await this.api.cachedMine().catch(() => null);
    if (!cached) return;
    this.list.set(cached);
    this.loaded.set(true);
  }

  refresh(): Promise<void> {
    return this.api
      .listMine()
      .then((l) => this.list.set(l), () => undefined)
      .finally(() => this.loaded.set(true));
  }
}
