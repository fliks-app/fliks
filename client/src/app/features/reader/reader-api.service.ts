import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { HttpFetcher, Link, Manifest, Publication, type FetchImplementation, type Locator } from '@readium/shared';
import { NetworkService } from '../../core/services/network.service';
import { OfflineBookStoreService } from '../../core/services/offline-book-store.service';
import { OfflinePlaybackSyncService } from '../../core/services/offline-playback-sync.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { SKIP_ERROR_TOAST } from '../../core/interceptors/error.interceptor';

/** The item being read: its media, its id and the file whose beat carries the progress. */
export interface ReaderTarget {
  mediaId: number;
  itemId: number;
  fileId: number;
  /** Storage key of the copy on the device, when the book was downloaded. */
  localKey?: string;
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
  private readonly store = inject(OfflineBookStoreService);
  private readonly network = inject(NetworkService);
  private readonly sync = inject(OfflinePlaybackSyncService);
  private readonly streaming = inject(StreamingApiService);

  manifestUrl(itemId: number): string {
    return this.store.manifestUrl(itemId);
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

  /** A chapter's markup with its resources left as written: its text needs none of them. */
  async markup(itemId: number, link: Link): Promise<string> {
    const url = link.toURL(this.manifestUrl(itemId));
    if (!url) throw new Error(`Invalid href ${link.href}`);
    const res = await this.store.fetch(url, undefined, false);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.text();
  }

  /** Lets go of what the chapters of the book held while it was open. */
  release(itemId: number): void {
    this.store.release(itemId);
  }

  /** Null when the user has not started the item. Without the server, the last position this device saved. */
  async loadProgress(t: ReaderTarget): Promise<Partial<ReaderProgress> | null> {
    const local = () => (this.sync.resumePositionFor(t.mediaId, undefined, t.itemId)?.extra as Partial<ReaderProgress> | undefined) ?? null;
    if (!this.network.isOnline()) return local();
    // Replayed first: the server's playedAt guard orders it against progress from another device.
    await this.sync.flush();
    return firstValueFrom(
      this.http.get<Partial<ReaderProgress> | null>(`/api/playback/media/${t.mediaId}/state`, {
        params: { itemId: t.itemId },
        context: silent(),
      }),
    ).catch(local);
  }

  /** A text beat names the item and carries no time; the server finishes the item at 0.99. One the server does not take is replayed once it answers. */
  async saveProgress(t: ReaderTarget, p: ReaderProgress): Promise<void> {
    const saved = { mediaId: t.mediaId, mediaFileId: t.fileId, itemId: t.itemId, positionSeconds: 0, durationSeconds: 0, extra: { ...p } };
    if (!this.network.isOnline()) return void this.sync.queue(saved);
    try {
      await firstValueFrom(
        this.http.put<void>(`/api/playback/media/${t.mediaId}/state`, { positionSeconds: 0, durationSeconds: 0, mediaFileId: t.fileId, itemId: t.itemId, playedAt: Date.now(), ...p }, { context: silent() }),
      );
      this.sync.record(saved);
    } catch {
      this.sync.queue(saved);
    }
  }

  /** A save for a page going away: a keepalive request outlives the unload, which an HttpClient call does not. */
  saveProgressOnExit(t: ReaderTarget, p: ReaderProgress): void {
    const saved = { mediaId: t.mediaId, mediaFileId: t.fileId, itemId: t.itemId, positionSeconds: 0, durationSeconds: 0, extra: { ...p } };
    if (!this.network.isOnline()) return void this.sync.queue(saved);
    const { url, init } = this.streaming.positionRequest(t.mediaId);
    fetch(url, { ...init, body: JSON.stringify({ positionSeconds: 0, durationSeconds: 0, mediaFileId: t.fileId, itemId: t.itemId, playedAt: Date.now(), ...p }) })
      .then((r) => (r.ok ? this.sync.record(saved) : this.sync.queue(saved)))
      .catch(() => this.sync.queue(saved));
  }

  /** The toolkit's own fetches: a stored resource of a downloaded book, else the network with the app's credentials. */
  private readonly authedFetch: FetchImplementation = (input, init) => this.store.fetch(input, init);
}

/** A resume lookup or a background save failing must not toast over a page being read. */
const silent = () => new HttpContext().set(SKIP_ERROR_TOAST, true);
