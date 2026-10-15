import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type EngineRemoteStatus = 'off' | 'up' | 'down';

export interface EnginePathMapping {
  from: string;
  to: string;
}

export interface EngineRemoteConfig {
  url: string;
  token: string;
  pathMappings: EnginePathMapping[];
  status: EngineRemoteStatus;
  /** `FLIKS_ENGINE_URL`. Video bytes follow this, not a different saved URL. */
  processUrl: string;
  mismatch?: boolean;
  error?: string;
}

export type EngineRemoteTestResult =
  | { ok: false; error: string }
  | {
      ok: true;
      engineVersion: string;
      protocolVersion: number;
      probeOk?: boolean;
      probeError?: string;
    };

@Injectable({ providedIn: 'root' })
export class EngineRemoteApiService {
  private readonly http = inject(HttpClient);

  get(): Promise<EngineRemoteConfig> {
    return firstValueFrom(this.http.get<EngineRemoteConfig>('/api/engine/remote'));
  }

  save(body: {
    url: string;
    token: string;
    pathMappings: EnginePathMapping[];
  }): Promise<EngineRemoteConfig> {
    return firstValueFrom(
      this.http.put<EngineRemoteConfig>('/api/engine/remote', body),
    );
  }

  test(body: {
    url: string;
    token: string;
    probePath?: string;
  }): Promise<EngineRemoteTestResult> {
    return firstValueFrom(
      this.http.post<EngineRemoteTestResult>('/api/engine/remote/test', body),
    );
  }
}
