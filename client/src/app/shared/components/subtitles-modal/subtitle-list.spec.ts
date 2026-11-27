import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { EMPTY, of } from 'rxjs';
import { SubtitleList } from './subtitle-list';
import { SubtitleFileRow, SubtitlesApiService } from '../../../core/services/api/subtitles-api.service';
import { SubtitleActionsService } from '../../../core/services/subtitle-actions.service';
import { ToastService } from '../../../core/services/toast.service';
import { SseService } from '../../../core/services/sse.service';
import { AppSettingsService } from '../../../core/services/app-settings.service';

const row = (over: Partial<SubtitleFileRow>): SubtitleFileRow =>
  ({ id: 1, mediaFileId: 1, language: 'eng', ...over }) as SubtitleFileRow;

const providers = (getForMedia: () => Promise<SubtitleFileRow[]>) => [
    provideZonelessChangeDetection(),
    provideTranslateService({
      lang: 'en',
      loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
    }),
    { provide: SubtitlesApiService, useValue: { getForMedia } },
    { provide: SubtitleActionsService, useValue: { syncing: () => new Set(), refreshSyncing: () => Promise.resolve() } },
    { provide: ToastService, useValue: { success: () => {}, error: () => {}, info: () => {} } },
    {
      provide: SseService,
      useValue: {
        on: () => EMPTY,
        translationProgress: () => ({}),
        retainTranslationProgress: () => {},
      },
    },
    {
      provide: AppSettingsService,
      useValue: { hideBurnInSubtitles: () => false, showSubtitleFormat: () => false },
    },
];

const fileId = signal<number | null>(1);
const list = () =>
  TestBed.runInInjectionContext(
    () => new SubtitleList({ mediaId: () => 1, fileId, streams: () => null, parked: () => false }),
  );

describe('SubtitleList.filteredSubtitles', () => {
  let l: SubtitleList;

  beforeEach(() => {
    fileId.set(1);
    // Never resolves: the auto-load must not race the direct signal writes below.
    TestBed.configureTestingModule({ providers: providers(() => new Promise(() => {})) });
    l = list();
  });

  it("lists only the active file's subtitles", () => {
    l.subtitles.set([row({ id: 1, mediaFileId: 1 }), row({ id: 2, mediaFileId: 2 }), row({ id: 3, mediaFileId: 1 })]);

    expect(l.filteredSubtitles().map((s) => s.id)).toEqual([1, 3]);
  });

  it('switches to the newly active file', () => {
    l.subtitles.set([row({ id: 1, mediaFileId: 1 }), row({ id: 2, mediaFileId: 2 })]);
    expect(l.filteredSubtitles().map((s) => s.id)).toEqual([1]);

    fileId.set(2);
    expect(l.filteredSubtitles().map((s) => s.id)).toEqual([2]);
  });

  it('yields nothing while no file is selected', () => {
    fileId.set(null);
    l.subtitles.set([row({ id: 1, mediaFileId: 1 })]);

    expect(l.filteredSubtitles()).toEqual([]);
  });
});

describe('SubtitleList auto-load', () => {
  it('fetches the list once with no modal built, and feeds the header', async () => {
    fileId.set(1);
    const getForMedia = vi.fn().mockResolvedValue([row({ id: 1 })]);
    TestBed.configureTestingModule({ providers: providers(getForMedia) });
    const l = list();

    for (let i = 0; i < 5; i++) {
      TestBed.tick();
      await Promise.resolve();
    }

    expect(l.headerSubtitles().length).toBe(1);
    expect(getForMedia).toHaveBeenCalledTimes(1);
  });
});
