import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { HttpFetcher, Link, Manifest, Publication, type FetchImplementation, type Locator } from '@readium/shared';
import { AuthService } from '../../core/services/auth.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { SKIP_ERROR_TOAST } from '../../core/interceptors/error.interceptor';

/** The item being read: its media, its id and the file whose beat carries the progress. */
export interface ReaderTarget {
  mediaId: number;
  itemId: number;
  fileId: number;
}

/** Where a reader stands: `progression` 0..1 over the whole book, `locator` a Readium locator (or a PDF page). */
export interface ReaderProgress {
  progression: number;
  locator: Record<string, unknown>;
}

export interface OpenedPublication {
  publication: Publication;
  positions: Locator[];
}

/** Every server call of the reader:
 *  - `/api/books/{itemId}/pub/*`: Readium manifest, positions and sanitised resources (EPUB);
 *  - `GET|PUT /api/playback/media/{mediaId}/state`: the progression and locator of the item. */
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

  /** Null when the user has not started the item. */
  async loadProgress(t: ReaderTarget): Promise<Partial<ReaderProgress> | null> {
    return firstValueFrom(
      this.http.get<Partial<ReaderProgress> | null>(`/api/playback/media/${t.mediaId}/state`, {
        params: { itemId: t.itemId },
        context: silent(),
      }),
    );
  }

  /** A text beat names the item and carries no time; the server finishes the item at 0.99. */
  saveProgress(t: ReaderTarget, p: ReaderProgress): Promise<void> {
    return firstValueFrom(
      this.http.put<void>(
        `/api/playback/media/${t.mediaId}/state`,
        { positionSeconds: 0, durationSeconds: 0, mediaFileId: t.fileId, itemId: t.itemId, ...p },
        { context: silent() },
      ),
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
