import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type TranslationEngine = 'gemini' | 'openai' | 'libretranslate';

export interface TranslationProviderRow {
  id: number;
  name: string;
  engine: TranslationEngine;
  enabled: boolean;
  isDefault: boolean;
  settings: Record<string, unknown>;
}

export interface CreateTranslationProviderBody {
  name: string;
  engine: TranslationEngine;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface TestTranslationProviderBody {
  engine: TranslationEngine;
  settings?: Record<string, unknown>;
}

/** Secret-free projection handed to a user when they trigger a translation. */
export interface AvailableTranslationProvider {
  id: number;
  name: string;
  engine: TranslationEngine;
  isDefault: boolean;
}

export interface TranslationTestResult {
  ok: boolean;
  error?: string;
}

const BASE = '/api/subtitles/translation-providers';

@Injectable({ providedIn: 'root' })
export class TranslationProvidersApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<TranslationProviderRow[]>(BASE));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<TranslationProviderRow>(`${BASE}/${id}`));
  }

  create(body: CreateTranslationProviderBody) {
    return firstValueFrom(this.http.post<TranslationProviderRow>(BASE, body));
  }

  update(id: number, body: Partial<CreateTranslationProviderBody>) {
    return firstValueFrom(this.http.put<TranslationProviderRow>(`${BASE}/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`${BASE}/${id}`));
  }

  testConnection(body: TestTranslationProviderBody) {
    return firstValueFrom(
      this.http.post<TranslationTestResult>(`${BASE}/test-connection`, body),
    );
  }

  testProvider(id: number) {
    return firstValueFrom(
      this.http.post<TranslationTestResult>(`${BASE}/${id}/test`, {}),
    );
  }

  /** Enabled providers (no secrets) for the translate picker. */
  getAvailable() {
    return firstValueFrom(
      this.http.get<AvailableTranslationProvider[]>(`${BASE}/available`),
    );
  }
}
