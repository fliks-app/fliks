import { vi } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { OrphanScanPanelComponent } from './orphan-scan-panel';
import {
  ImportsApiService,
  OrphanScanResult,
  RelinkOrphansBody,
} from '../../../../../core/services/api/imports-api.service';
import {
  MetadataService,
  MetadataSearchResult,
} from '../../../../../core/services/api/metadata.service';
import { ToastService } from '../../../../../core/services/toast.service';

const result = (
  tmdbId: number,
  title: string,
  extra: Partial<MetadataSearchResult> = {},
): MetadataSearchResult => ({
  tmdbId,
  provider: 'tmdb',
  title,
  originalTitle: title,
  overview: '',
  year: 2001,
  posterUrl: null,
  rating: 0,
  genres: [],
  mediaType: 'movie',
  existingMediaId: null,
  existingMediaType: null,
  ...extra,
});

const scanResult = (folders: string[]): OrphanScanResult => ({
  libraryPath: '/medias',
  groups: folders.map((folderName) => ({
    groupKey: `movie:${folderName}`,
    mediaType: 'movie',
    folderName,
    guessTitle: folderName,
    guessYear: 2001,
    nfo: null,
    suggestedProvider: 'tmdb',
    files: [
      {
        filePath: `/medias/${folderName}/a.mkv`,
        filename: 'a.mkv',
        size: 1,
        qualityName: 'HDTV-720p',
        qualityId: 1,
        seasonNumber: null,
        episodeNumber: null,
        episodeEnd: null,
      },
    ],
  })),
  scannedFiles: folders.length,
  orphanCount: folders.length,
});

function setup(folders: string[], metadataOverrides: Record<string, unknown> = {}) {
  const relinked: RelinkOrphansBody[] = [];
  const linked: RelinkOrphansBody[] = [];
  const importsApi = {
    previewOrphans: () => Promise.resolve(scanResult(folders)),
    relinkOrphansBatch: (items: RelinkOrphansBody[]) => {
      relinked.push(...items);
      return Promise.resolve({ queued: items.length });
    },
    relinkOrphans: (body: RelinkOrphansBody) => {
      linked.push(body);
      return Promise.resolve({ mediaId: 1, created: true, linked: body.files.length, errors: [] });
    },
  };
  const metadata = {
    searchMovie: () => Promise.resolve([result(11, 'First'), result(22, 'Second')]),
    searchTv: () => Promise.resolve([]),
    ...metadataOverrides,
  };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ImportsApiService, useValue: importsApi as unknown as ImportsApiService },
      { provide: MetadataService, useValue: metadata as unknown as MetadataService },
      { provide: ToastService, useValue: { success: () => undefined } },
    ],
  });
  const fixture = TestBed.createComponent(OrphanScanPanelComponent);
  return { panel: fixture.componentInstance, relinked, linked };
}

describe('OrphanScanPanelComponent.importAll', () => {
  it('queues every detected group, defaulting to the first result', async () => {
    const { panel, relinked } = setup(['Alpha', 'Beta']);
    await panel.scanPath('/medias', ['movie'], 'tmdb');

    expect(await panel.importAll(7)).toEqual({ queued: 2, unmatched: 0, failed: 0 });
    expect(relinked.map((b) => [b.folderName, b.externalId, b.libraryId])).toEqual([
      ['Alpha', '11', 7],
      ['Beta', '11', 7],
    ]);
  });

  it('adds a group whose default pick was deselected as unmatched, without dropping it', async () => {
    const { panel, relinked } = setup(['Alpha', 'Beta']);
    await panel.scanPath('/medias', ['movie'], 'tmdb');
    panel.pick(0, panel.groups()[0].pick!); // clicking the selected row clears it

    expect(await panel.importAll(7)).toEqual({ queued: 2, unmatched: 1, failed: 0 });
    const alpha = relinked.find((b) => b.folderName === 'Alpha')!;
    expect(alpha.externalId).toBeUndefined();
    expect(alpha.title).toBe('Alpha');
    expect(alpha.year).toBe(2001);
    expect(alpha.reorganize).toBe(false);
    const beta = relinked.find((b) => b.folderName === 'Beta')!;
    expect(beta.externalId).toBe('11');
  });

  it('selects the first result as soon as a group is searched', async () => {
    const { panel } = setup(['Alpha']);
    await panel.scanPath('/medias', ['movie'], 'tmdb');

    expect(panel.groups()[0].pick?.title).toBe('First');
    expect(panel.groups()[0].fromNfo).toBe(false);
  });

  it('keeps an explicit pick over the first result', async () => {
    const { panel, relinked } = setup(['Alpha']);
    await panel.scanPath('/medias', ['movie'], 'tmdb');
    panel.pick(0, result(22, 'Second'));

    await panel.importAll(7);
    expect(relinked[0].externalId).toBe('22');
  });
});

describe('OrphanScanPanelComponent.linkAll', () => {
  it('searches a not-yet-searched group before linking it, rather than adding it unmatched blind', async () => {
    const folders = Array.from({ length: 25 }, (_, i) => `F${i}`);
    const { panel, linked } = setup(folders);
    await panel.scanPath('/medias', ['movie'], 'tmdb');
    // Page 2 was never opened, so its groups never went through search().
    expect(panel.groups()[24].searched).toBe(false);

    await panel.linkAll();

    expect(panel.groups()[24].searched).toBe(true);
    const last = linked.find((b) => b.folderName === 'F24');
    expect(last?.externalId).toBe('11');
  });
});

describe('OrphanScanPanelComponent: a group whose search errored', () => {
  const withOneFailing = (folders: string[], failing: string) =>
    setup(folders, {
      searchMovie: (query: string) =>
        query === failing
          ? Promise.reject({ status: 500, error: {} })
          : Promise.resolve([result(11, 'First')]),
    });

  it('is not queued by importAll, and is counted as failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { panel, relinked } = withOneFailing(['Alpha', 'Beta'], 'Beta');
    await panel.scanPath('/medias', ['movie'], 'tmdb');

    expect(await panel.importAll(7)).toEqual({ queued: 1, unmatched: 0, failed: 1 });
    expect(relinked.map((b) => b.folderName)).toEqual(['Alpha']);
  });

  it('is not linked unmatched by autoImportAll', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { panel, linked } = withOneFailing(['Alpha', 'Beta'], 'Beta');
    await panel.scanPath('/medias', ['movie'], 'tmdb');
    expect(panel.groups()[1].error).toBeTruthy();

    await panel.autoImportAll();

    expect(panel.groups()[1].done).toBe(false);
    expect(linked.some((b) => b.folderName === 'Beta')).toBe(false);
    expect(linked.some((b) => b.folderName === 'Alpha')).toBe(true);
  });
});

/** A TVDB work TheMovieDB does not know is reported with `tmdbId: 0`, so every
 *  such row would answer to the same identity. */
describe('OrphanScanPanelComponent — picking among TVDB-only results', () => {
  const tvdb = (tvdbId: number, title: string) => result(0, title, { provider: 'tvdb', tvdbId });

  it('VERDICT: switches the pick between two results that share tmdbId 0', async () => {
    const { panel } = setup(['Alpha']);
    await panel.scanPath('/medias', ['movie'], 'tvdb');
    const first = tvdb(101, 'First');
    const second = tvdb(202, 'Second');

    panel.pick(0, first);
    panel.pick(0, second);

    expect(panel.groups()[0].pick).toBe(second);
  });

  it('still deselects when the same result is clicked twice', async () => {
    const { panel } = setup(['Alpha']);
    await panel.scanPath('/medias', ['movie'], 'tvdb');
    const first = tvdb(101, 'First');

    panel.pick(0, first);
    panel.pick(0, { ...first });

    expect(panel.groups()[0].pick).toBeNull();
  });

  it('marks only the picked row as selected', () => {
    const { panel } = setup(['Alpha']);
    const first = tvdb(101, 'First');
    const second = tvdb(202, 'Second');

    expect(panel.isPicked(first, first)).toBe(true);
    expect(panel.isPicked(first, second)).toBe(false);
  });
});

describe('OrphanScanPanelComponent — a failing search', () => {
  it('VERDICT: shows the server\'s own reason instead of a bare "scan failed"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { panel } = setup(['Alpha'], {
      searchMovie: () =>
        Promise.reject({
          status: 503,
          error: { message: 'Metadata search failed on tmdb: HTTP 401 — Invalid API key' },
        }),
    });
    await panel.scanPath('/medias', ['movie'], 'tmdb');

    expect(panel.groups()[0].error).toBe(
      'Metadata search failed on tmdb: HTTP 401 — Invalid API key (HTTP 503)',
    );
  });
});

describe('OrphanScanPanelComponent - a movie file directly at the library root', () => {
  function setupRoot(filename: string, metadataOverrides: Record<string, unknown> = {}) {
    const relinked: RelinkOrphansBody[] = [];
    const rootResult: OrphanScanResult = {
      libraryPath: '/medias',
      groups: [
        {
          groupKey: `movie:/medias/${filename}`,
          mediaType: 'movie',
          folderName: '',
          guessTitle: 'Sample Movie',
          guessYear: 2020,
          nfo: null,
          suggestedProvider: 'tmdb',
          files: [
            {
              filePath: `/medias/${filename}`,
              filename,
              size: 1,
              qualityName: 'HDTV-720p',
              qualityId: 1,
              seasonNumber: null,
              episodeNumber: null,
              episodeEnd: null,
            },
          ],
        },
      ],
      scannedFiles: 1,
      orphanCount: 1,
    };
    const importsApi = {
      previewOrphans: () => Promise.resolve(rootResult),
      relinkOrphansBatch: (items: RelinkOrphansBody[]) => {
        relinked.push(...items);
        return Promise.resolve({ queued: items.length });
      },
      relinkOrphans: (body: RelinkOrphansBody) => {
        relinked.push(body);
        return Promise.resolve({ mediaId: 1, created: true, linked: body.files.length, errors: [] });
      },
    };
    const metadata = {
      searchMovie: () => Promise.resolve([result(11, 'Sample Movie')]),
      searchTv: () => Promise.resolve([]),
      ...metadataOverrides,
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
        { provide: ImportsApiService, useValue: importsApi as unknown as ImportsApiService },
        { provide: MetadataService, useValue: metadata as unknown as MetadataService },
        { provide: ToastService, useValue: { success: () => undefined } },
      ],
    });
    const fixture = TestBed.createComponent(OrphanScanPanelComponent);
    return { panel: fixture.componentInstance, fixture, relinked };
  }

  it('shows the file name in the collapsed header instead of the empty folder name', async () => {
    const { panel, fixture } = setupRoot('sample.movie.2001.mkv');
    await panel.scanPath('/medias', ['movie'], 'tmdb');
    fixture.detectChanges();

    const header = fixture.nativeElement.querySelector('.collapse-title .font-mono');
    expect(header?.textContent?.trim()).toBe('sample.movie.2001.mkv');
  });

  it('forwards folderName \'\' untouched and forces reorganize off even with a match', async () => {
    const { panel, relinked } = setupRoot('sample.movie.2001.mkv');
    await panel.scanPath('/medias', ['movie'], 'tmdb');
    expect(panel.groups()[0].pick?.title).toBe('Sample Movie');

    await panel.importAll(7);

    expect(relinked).toHaveLength(1);
    expect(relinked[0].folderName).toBe('');
    expect(relinked[0].externalId).toBe('11');
    expect(relinked[0].reorganize).toBe(false);
  });

  it('explains why reorganize is skipped for a root-level movie', async () => {
    const { panel } = setupRoot('sample.movie.2001.mkv');
    await panel.scanPath('/medias', ['movie'], 'tmdb');

    expect(panel.reorganizeTooltip(panel.groups()[0])).toBe(
      'settings.libraries.scan_reorganize_needs_folder',
    );
  });
});

describe('OrphanScanPanelComponent pagination', () => {
  it('pages the groups and only searches the visible ones', async () => {
    const folders = Array.from({ length: 25 }, (_, i) => `F${i}`);
    const { panel } = setup(folders);
    await panel.scanPath('/medias', ['movie'], 'tmdb');

    expect(panel.pageCount()).toBe(2);
    expect(panel.pagedGroups().length).toBe(20);
    expect(panel.groups().filter((g) => g.searched).length).toBe(20);

    await panel.goToPage(2);
    expect(panel.pagedGroups().length).toBe(5);
    expect(panel.groups().filter((g) => g.searched).length).toBe(25);
  });
});
