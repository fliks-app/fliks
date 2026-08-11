import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface SidebarCounts {
  /** Keyed by a nav contribution's `badge` field; a key no publisher
   *  pushed is absent from the map, never present-and-0. */
  badgeCounts: Record<string, number>;
  /** Pending requests visible to the user (own only without requests.manage). */
  pendingRequests: number;
  /** Media count per accessible library id. */
  mediaByLibrary: Record<number, number>;
}

/** Aggregated badge counts for the app shell, one round-trip for the sidebar. */
@Injectable({ providedIn: 'root' })
export class CountsApiService {
  private readonly http = inject(HttpClient);

  get() {
    return firstValueFrom(this.http.get<SidebarCounts>('/api/counts'));
  }
}
