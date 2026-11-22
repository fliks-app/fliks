import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface SidebarCounts {
  /** Keyed by a nav contribution's `badge` field; a key no publisher
   *  pushed is absent from the map, never present-and-0. */
  badgeCounts: Record<string, number>;
  /** Pending requests visible to the user (own only without requests.manage). */
  pendingRequests: number;
  /** Requests waiting for this user's decision plus follow requests waiting for an answer; absent from an older server. */
  attention?: number;
  /** Open health checks in error, admins only; absent from an older server. */
  systemAttention?: number;
  /** Media count per accessible library id. */
  mediaByLibrary: Record<number, number>;
}

/** Aggregated badge counts for the app shell, one round-trip for the sidebar. */
@Injectable({ providedIn: 'root' })
export class CountsApiService {
  private readonly http = inject(HttpClient);

  /** Open health checks in error, for the red dot of the Administration entry. */
  readonly systemAttention = signal(0);

  async get() {
    const counts = await firstValueFrom(this.http.get<SidebarCounts>('/api/counts'));
    this.systemAttention.set(counts.systemAttention ?? 0);
    return counts;
  }
}
