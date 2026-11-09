import type { MediaType } from '../../core/enums/media-type.enum';
import type { BooksApiService } from '../../core/services/api/books-api.service';
import type { MediaService, SearchParams } from '../../core/services/api/media.service';
import type { MetadataService } from '../../core/services/api/metadata.service';
import type { MusicApiService } from '../../core/services/api/music-api.service';
import type { SearchSource, SearchStateService } from '../../core/services/search-state.service';
import { isAbort } from '../../core/utils/abortable';

export type ContentChip = 'all' | MediaType;

/** What each chip asks of the library and of the providers. */
export const SOURCES: Record<'all' | 'movie' | 'series' | 'book' | 'album', { local: SearchSource[]; provider: SearchSource[] }> = {
  all: { local: ['media', 'tracks', 'artists'], provider: ['movie', 'tv', 'book', 'album', 'artist', 'recording'] },
  movie: { local: ['media'], provider: ['movie'] },
  series: { local: ['media'], provider: ['tv'] },
  book: { local: ['media', 'authors', 'series'], provider: ['book'] },
  album: { local: ['media', 'tracks', 'artists'], provider: ['album', 'artist', 'recording'] },
};

export const sourcesOf = (chip: ContentChip) => SOURCES[chip === 'comic' ? 'all' : chip];

/** The provider calls start from this many characters; the library from one. */
export const PROVIDER_MIN_CHARS = 2;

export interface RunDeps {
  state: SearchStateService;
  media: MediaService;
  metadata: MetadataService;
  music: MusicApiService;
  books: BooksApiService;
}

/** Runs the sources of one query together: each lands in the state on its own, and a new run cancels the one before. */
export class SearchRunner {
  private ctl: AbortController | null = null;
  private mediaCtl: AbortController | null = null;

  constructor(private readonly d: RunDeps) {}

  cancel(): void {
    this.ctl?.abort();
    this.mediaCtl?.abort();
    this.ctl = this.mediaCtl = null;
    this.d.state.pending.set(new Set());
  }

  run(q: string, chip: ContentChip, opts: { external: boolean; mediaParams: SearchParams }): void {
    this.ctl?.abort();
    this.mediaCtl?.abort();
    const { signal } = (this.ctl = new AbortController());
    const mediaSignal = (this.mediaCtl = new AbortController()).signal;
    const { state: s, media, metadata, music, books } = this.d;
    const want = sourcesOf(chip);
    const provider = opts.external && q.length >= PROVIDER_MIN_CHARS ? want.provider : [];
    s.failed.set(new Set());
    this.dropOthers([...want.local, ...provider]);

    const jobs: [SearchSource, (() => Promise<void>)][] = [
      ['media', async () => s.localResults.set((await media.getAll({ ...opts.mediaParams, q, limit: 20 }, { force: true }, mediaSignal)).data)],
      ['tracks', async () => s.localTracks.set(await music.tracks({ q, limit: 12 }, signal))],
      ['artists', async () => s.localArtists.set(await music.people('artist', { q, limit: 12 }, signal))],
      ['authors', async () => s.localAuthors.set(await books.persons({ role: 'author', q, limit: 12 }, signal))],
      ['series', async () => s.localSeries.set(await books.collections({ kind: 'book', q, limit: 12 }, signal))],
      ['movie', async () => s.movieHits.set(await metadata.search('movie', q, {}, signal))],
      ['tv', async () => s.seriesHits.set(await metadata.search('series', q, {}, signal))],
      ['book', async () => s.bookHits.set(await metadata.search('book', q, {}, signal))],
      ['album', async () => s.albumHits.set(await metadata.search('album', q, {}, signal))],
      ['artist', async () => s.artistHits.set(await metadata.searchArtists(q, {}, signal))],
      ['recording', async () => s.recordingHits.set(await metadata.searchRecordings(q, {}, signal))],
    ];
    const asked = jobs.filter(([k]) => want.local.includes(k) || provider.includes(k));
    s.pending.set(new Set(asked.map(([k]) => k)));
    for (const [key, job] of asked) void this.settle(key, job, key === 'media' ? mediaSignal : signal);
  }

  /** The library media alone, after a filter change; the provider calls go on. */
  runMedia(q: string, mediaParams: SearchParams): void {
    this.mediaCtl?.abort();
    const { signal } = (this.mediaCtl = new AbortController());
    const s = this.d.state;
    s.pending.update((p) => new Set(p).add('media'));
    void this.settle(
      'media',
      async () => s.localResults.set((await this.d.media.getAll({ ...mediaParams, q, limit: 20 }, { force: true }, signal)).data),
      signal,
    );
  }

  private async settle(key: SearchSource, job: () => Promise<void>, signal: AbortSignal): Promise<void> {
    try {
      await job();
    } catch (e) {
      if (signal.aborted || isAbort(e)) return;
      this.d.state.failed.update((f) => new Set(f).add(key));
    }
    if (signal.aborted) return;
    this.d.state.pending.update((p) => {
      const next = new Set(p);
      next.delete(key);
      return next;
    });
  }

  /** A chip change empties the sources the new chip does not ask. */
  private dropOthers(keep: SearchSource[]): void {
    const s = this.d.state;
    const lists: Record<SearchSource, { set(v: never[]): void }> = {
      media: s.localResults, tracks: s.localTracks, artists: s.localArtists, authors: s.localAuthors, series: s.localSeries,
      movie: s.movieHits, tv: s.seriesHits, book: s.bookHits, album: s.albumHits, artist: s.artistHits, recording: s.recordingHits,
    };
    for (const [k, l] of Object.entries(lists)) if (!keep.includes(k as SearchSource)) l.set([]);
  }
}
