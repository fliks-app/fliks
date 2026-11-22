import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface SystemCheck {
  key: string;
  state: 'warn' | 'error';
  /** Selects the sentence `system.checks.<code>`; a code this client lacks falls back to a generic one. */
  code: string;
  params: Record<string, string | number>;
  /** A client route, or null when there is nowhere to go. */
  link: string | null;
  since: string;
}

export interface SystemChecksReport {
  checkedAt: string | null;
  /** Only the checks that are not ok, errors first. */
  checks: SystemCheck[];
}

@Injectable({ providedIn: 'root' })
export class SystemChecksApiService {
  private readonly http = inject(HttpClient);

  get() {
    return firstValueFrom(this.http.get<SystemChecksReport>('/api/system/checks'));
  }

  run() {
    return firstValueFrom(this.http.post<SystemChecksReport>('/api/system/checks/run', {}));
  }
}
