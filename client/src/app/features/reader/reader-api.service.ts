import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { HttpFetcher, Link, Manifest, Publication, type FetchImplementation, type Locator } from '@readium/shared';
import { AuthService } from '../../core/services/auth.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { SKIP_ERROR_TOAST } from '../../core/interceptors/error.interceptor';

/** Where a reader stands: `progression` 0..1 over the whole book, `locator` a serialised Readium locator. */
export interface ReaderProgress {
  progression: number;
  locator: string;
}

export interface OpenedPublication {
  publication: Publication;
  positions: Locator[];
}

/** Every server call of the reader, against `/api/books/{itemId}`:
 *  - `pub/manifest.json`: Readium web publication manifest, links `positions.json`;
 *  - `pub/positions.json`: the position list;
 *  - `pub/{zip path}`: the book's resources, sanitised;
 *  - `GET|PUT progress`: `{progression, locator}` of the signed-in user. */
@Injectable({ providedIn: 'root' })
export class ReaderApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);

  manifestUrl(itemId: number): string {
    const path = this.serverConfig.resolveUrl(`/api/books/${itemId}/pub/manifest.json`);
    return new URL(path, document.baseURI).href;
  }

  async open(itemId: number): Promise<OpenedPublication> {
    const selfUrl = this.manifestUrl(itemId);
    const fetcher = new HttpFetcher(this.authedFetch, selfUrl);
    const json = await fetcher.get(new Link({ href: 'manifest.json' })).readAsJSON();
    const manifest = Manifest.deserialize(json);
    if (!manifest) throw new Error('Invalid publication manifest');
    manifest.setSelfLink(selfUrl);
    const publication = new Publication({ manifest, fetcher });
    return { publication, positions: await publication.positionsFromManifest() };
  }

  /** Null when the user has not started the book. */
  async loadProgress(itemId: number): Promise<ReaderProgress | null> {
    try {
      return await firstValueFrom(
        this.http.get<ReaderProgress>(`/api/books/${itemId}/progress`, { context: silent() }),
      );
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 404) return null;
      throw err;
    }
  }

  saveProgress(itemId: number, progress: ReaderProgress): Promise<void> {
    return firstValueFrom(
      this.http.put<void>(`/api/books/${itemId}/progress`, progress, { context: silent() }),
    );
  }

  /** Native bundles have no cookie, so the toolkit's own fetches carry the bearer token. */
  private readonly authedFetch: FetchImplementation = (input, init) => {
    const headers = new Headers(init?.headers);
    const token = this.auth.accessToken;
    if (this.serverConfig.isNative && token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers, credentials: this.serverConfig.isNative ? 'omit' : 'include' });
  };
}

/** A resume lookup or a background save failing must not toast over a page being read. */
const silent = () => new HttpContext().set(SKIP_ERROR_TOAST, true);
