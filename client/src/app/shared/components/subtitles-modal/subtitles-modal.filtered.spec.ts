import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { SubtitlesModalComponent } from './subtitles-modal';
import { SubtitleFileRow, SubtitlesApiService } from '../../../core/services/api/subtitles-api.service';
import { SubtitleActionsService } from '../../../core/services/subtitle-actions.service';
import { TranslationProvidersApiService } from '../../../core/services/api/translation-providers-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import { ProfilesService } from '../../../core/services/api/profiles.service';
import { SseService } from '../../../core/services/sse.service';
import { AppSettingsService } from '../../../core/services/app-settings.service';
import { StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { DeviceService } from '../../../core/services/device.service';
import { CardActionsService } from '../../../core/services/card-actions.service';

const row = (over: Partial<SubtitleFileRow>): SubtitleFileRow =>
  ({ id: 1, mediaFileId: 1, language: 'eng', ...over }) as SubtitleFileRow;

const providers = (getForMedia: () => Promise<SubtitleFileRow[]>) => [
    provideZonelessChangeDetection(),
    provideRouter([]),
    provideTranslateService({
      lang: 'en',
      loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
    }),
    { provide: SubtitlesApiService, useValue: { getForMedia } },
    { provide: SubtitleActionsService, useValue: {} },
    { provide: TranslationProvidersApiService, useValue: {} },
    { provide: ConfirmationService, useValue: {} },
    { provide: ToastService, useValue: { success: () => {}, error: () => {}, info: () => {} } },
    { provide: ProfilesService, useValue: { getLanguageProfiles: () => new Promise(() => {}) } },
    {
      provide: SseService,
      useValue: {
        lastEvent: () => null,
        translationProgress: () => ({}),
        retainTranslationProgress: () => {},
      },
    },
    {
      provide: AppSettingsService,
      useValue: { hideBurnInSubtitles: () => false, showSubtitleFormat: () => false },
    },
    { provide: StreamingApiService, useValue: {} },
    {
      provide: DeviceService,
      useValue: { canSaveFiles: () => false, isTv: () => false, isAndroidNative: () => false },
    },
    { provide: CardActionsService, useValue: { register: () => {}, show: () => {} } },
];

describe('SubtitlesModalComponent.filteredSubtitles', () => {
  let fixture: ComponentFixture<SubtitlesModalComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      // Never resolves: the modal's own auto-load must not race the direct signal writes below.
      providers: providers(() => new Promise(() => {})),
    });

    fixture = TestBed.createComponent(SubtitlesModalComponent);
    fixture.componentRef.setInput('mediaId', 1);
    fixture.componentRef.setInput('selectedFileId', 1);
  });

  it("lists only the active file's subtitles", () => {
    fixture.componentInstance.subtitles.set([
      row({ id: 1, mediaFileId: 1 }),
      row({ id: 2, mediaFileId: 2 }),
      row({ id: 3, mediaFileId: 1 }),
    ]);

    expect(fixture.componentInstance.filteredSubtitles().map((s) => s.id)).toEqual([1, 3]);
  });

  it('switches to the newly active file when selectedFileId changes', () => {
    fixture.componentInstance.subtitles.set([
      row({ id: 1, mediaFileId: 1 }),
      row({ id: 2, mediaFileId: 2 }),
    ]);
    expect(fixture.componentInstance.filteredSubtitles().map((s) => s.id)).toEqual([1]);

    fixture.componentRef.setInput('selectedFileId', 2);
    expect(fixture.componentInstance.filteredSubtitles().map((s) => s.id)).toEqual([2]);
  });

  it('yields nothing while no file is selected', () => {
    fixture.componentRef.setInput('selectedFileId', null);
    fixture.componentInstance.subtitles.set([row({ id: 1, mediaFileId: 1 })]);

    expect(fixture.componentInstance.filteredSubtitles()).toEqual([]);
  });
});

describe('SubtitlesModalComponent auto-load', () => {
  it('fetches the list once, not again when the answer lands', async () => {
    const getForMedia = vi.fn().mockResolvedValue([row({ id: 1 })]);
    TestBed.configureTestingModule({ providers: providers(getForMedia) });
    const fixture = TestBed.createComponent(SubtitlesModalComponent);
    fixture.componentRef.setInput('mediaId', 1);
    fixture.componentRef.setInput('selectedFileId', 1);

    for (let i = 0; i < 5; i++) {
      TestBed.tick();
      await Promise.resolve();
    }

    expect(fixture.componentInstance.subtitles().length).toBe(1);
    expect(getForMedia).toHaveBeenCalledTimes(1);
  });
});
