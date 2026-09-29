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
      { provide: ToastService, useValue: { success: () => undefined, info: () => undefined } },
    ],
  });
  const fixture = TestBed.createComponent(OrphanScanPanelComponent);
  return { panel: fixture.componentInstance, fixture, relinked, linked };
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

describe('OrphanScanPanelComponent.autoImportAll', () => {
  it('caps concurrent relinks instead of firing every group at once', async () => {
    const folders = Array.from({ length: 7 }, (_, i) => `F${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const importsApi = {
      previewOrphans: () => Promise.resolve(scanResult(folders)),
      relinkOrphansBatch: () => Promise.resolve({ queued: 0 }),
      relinkOrphans: async (body: RelinkOrphansBody) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight--;
        return {
          mediaId: 1,
          created: true,
          linked: body.files.length,
          alreadyPresent: 0,
          errors: [],
        };
      },
    };
    const metadata = {
      searchMovie: () => Promise.resolve([result(11, 'First')]),
      searchTv: () => Promise.resolve([]),
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
        { provide: ToastService, useValue: { success: () => undefined, info: () => undefined } },
      ],
    });
    const panel = TestBed.createComponent(OrphanScanPanelComponent).componentInstance;
    await panel.scanPath('/medias', ['movie'], 'tmdb');

    await panel.autoImportAll();

    expect(maxInFlight).toBe(3);
    expect(panel.groups().every((g) => g.done)).toBe(true);
  });
});

describe('OrphanScanPanelComponent.link: files already present', () => {
  it('marks the group done with an info toast instead of a false error', async () => {
    const folders = ['Alpha'];
    const importsApi = {
      previewOrphans: () => Promise.resolve(scanResult(folders)),
      relinkOrphansBatch: () => Promise.resolve({ queued: 0 }),
      relinkOrphans: () =>
        Promise.resolve({
          mediaId: 1,
          created: false,
          linked: 0,
          alreadyPresent: 1,
          errors: [],
        }),
    };
    const metadata = {
      searchMovie: () => Promise.resolve([result(11, 'First')]),
      searchTv: () => Promise.resolve([]),
    };
    let infoMessage = '';
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({
          lang: 'en',
          loader: {
            provide: TranslateLoader,
            useValue: { getTranslation: () => of({ settings: { libraries: { scan_already_present: '1 already present' } } }) },
          },
        }),
        { provide: ImportsApiService, useValue: importsApi as unknown as ImportsApiService },
        { provide: MetadataService, useValue: metadata as unknown as MetadataService },
        {
          provide: ToastService,
          useValue: { success: () => undefined, info: (m: string) => (infoMessage = m) },
        },
      ],
    });
    const panel = TestBed.createComponent(OrphanScanPanelComponent).componentInstance;
    await panel.scanPath('/medias', ['movie'], 'tmdb');

    await panel.link(0);

    expect(panel.groups()[0].done).toBe(true);
    expect(panel.groups()[0].error).toBe('');
    expect(infoMessage).toBe('1 already present');
  });
});

describe('OrphanScanPanelComponent: scan generation', () => {
  it('drops a reply from an earlier scan instead of patching the wrong group in a newer one', async () => {
    const folders = Array.from({ length: 21 }, (_, i) => `A${i}`);
    let release!: (r: MetadataSearchResult[]) => void;
    const { panel } = setup(folders, {
      searchMovie: (query: string) =>
        query === 'A20'
          ? new Promise<MetadataSearchResult[]>((r) => (release = r))
          : Promise.resolve([result(11, 'First')]),
    });
    await panel.scanPath('/medias', ['movie'], 'tmdb');
    // Page 2 (index 20) is searched here, standing in for the user opening it —
    // load() itself only auto-searches page 1.
    const stalePending = panel.search(20);
    await vi.waitFor(() => expect(release).toBeDefined());

    // A second scan (the library changed) replaces the groups before that search resolves.
    await panel.scanPath('/medias', ['movie'], 'tmdb');
    expect(panel.groups()).toHaveLength(21);
    expect(panel.groups()[20].searched).toBe(false);

    release([result(99, 'Wrong group')]);
    await stalePending;

    // The reply belonged to the first scan's own group 20 — it must never land on
    // the second scan's group 20, an unrelated, not-yet-searched group.
    expect(panel.groups()[20].searched).toBe(false);
    expect(panel.groups()[20].pick).toBeNull();
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

describe('OrphanScanPanelComponent in transfer mode', () => {
  it('links into the scanned library with the chosen transfer method', async () => {
    const { panel, fixture, linked } = setup(['Alpha']);
    fixture.componentRef.setInput('transfer', 'copy');
    await panel.scanPath('/downloads', ['movie'], 'tmdb', 7);
    await panel.link(0);

    expect(linked.map((b) => [b.libraryId, b.externalId, b.transfer])).toEqual([[7, '11', 'copy']]);
  });
});

describe('OrphanScanPanelComponent.edit', () => {
  const byQuery = {
    searchMovie: (query: string) =>
      Promise.resolve(query === 'Renamed' ? [result(33, 'Renamed')] : [result(11, 'First')]),
  };

  it('searches a renamed group again instead of importing the old name match', async () => {
    const { panel, relinked } = setup(['Alpha', 'Beta'], byQuery);
    await panel.scanPath('/medias', ['movie'], 'tmdb');
    panel.edit(1, { query: 'Renamed' });

    expect(panel.groups()[1].pick).toBeNull();
    await panel.importAll(7);
    expect(relinked.map((b) => [b.folderName, b.externalId])).toEqual([
      ['Alpha', '11'],
      ['Beta', '33'],
    ]);
  });

  it('saves the edited name on the group it was typed in when added unmatched', async () => {
    const { panel, linked } = setup(['Alpha', 'Beta'], byQuery);
    await panel.scanPath('/medias', ['movie'], 'tmdb');
    panel.edit(1, { query: 'Renamed' });
    await panel.search(1);
    panel.pickUnmatched(1);
    await panel.link(1);

    expect(linked).toHaveLength(1);
    expect(linked[0].folderName).toBe('Beta');
    expect(linked[0].title).toBe('Renamed');
    expect(linked[0].externalId).toBeUndefined();
  });

  it('drops a search that finishes after the name changed', async () => {
    let release!: () => void;
    const { panel } = setup(['Alpha'], {
      searchMovie: (query: string) =>
        query === 'Alpha'
          ? new Promise((r) => (release = () => r([result(11, 'First')])))
          : Promise.resolve([result(33, 'Renamed')]),
    });
    const scanned = panel.scanPath('/medias', ['movie'], 'tmdb');
    await vi.waitFor(() => expect(release).toBeDefined());
    panel.edit(0, { query: 'Renamed' });
    await panel.search(0);
    release();
    await scanned;

    expect(panel.groups()[0].pick?.tmdbId).toBe(33);
    expect(panel.groups()[0].searching).toBe(false);
  });
});
