import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type ChecklistItemSeverity = 'required' | 'recommended';

/** Core's own keys join whatever a bundle registers (mirrors the backend's
 *  `ChecklistItemRegistry`) — not a fixed union anymore. */
export type ChecklistItemKey = string;

export interface ChecklistItem {
  key: ChecklistItemKey;
  severity: ChecklistItemSeverity;
  done: boolean;
  dismissed: boolean;
  route: string[];
}

@Injectable({ providedIn: 'root' })
export class SetupChecklistApiService {
  private readonly http = inject(HttpClient);

  /** Cached list of items so multiple consumers (home widget + admin
   *  page) share one network request. Cleared on dismiss/undismiss/refresh. */
  readonly items = signal<ChecklistItem[]>([]);
  readonly loading = signal(false);

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const data = await firstValueFrom(
        this.http.get<ChecklistItem[]>('/api/setup-checklist'),
      );
      this.items.set(data);
    } finally {
      this.loading.set(false);
    }
  }

  async dismiss(key: ChecklistItemKey): Promise<void> {
    await firstValueFrom(
      this.http.post<{ ok: boolean }>(
        `/api/setup-checklist/${key}/dismiss`,
        {},
      ),
    );
    this.items.update((items) =>
      items.map((i) => (i.key === key ? { ...i, dismissed: true } : i)),
    );
  }

  async undismiss(key: ChecklistItemKey): Promise<void> {
    await firstValueFrom(
      this.http.delete<{ ok: boolean }>(
        `/api/setup-checklist/${key}/dismiss`,
      ),
    );
    this.items.update((items) =>
      items.map((i) => (i.key === key ? { ...i, dismissed: false } : i)),
    );
  }
}
