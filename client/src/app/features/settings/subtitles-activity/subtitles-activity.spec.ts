import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { SubtitlesActivityComponent } from './subtitles-activity';
import {
  SubtitlesApiService,
  SubtitleHistoryEntry,
} from '../../../core/services/api/subtitles-api.service';

const entry = (errorMessage: string | null): SubtitleHistoryEntry =>
  ({ id: 1, status: 'failed', syncFailed: false, errorMessage }) as SubtitleHistoryEntry;

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: {
          provide: TranslateLoader,
          useValue: {
            getTranslation: () => of({ activity: { subtitle_error_interrupted: 'Interrupted' } }),
          },
        },
      }),
      {
        provide: SubtitlesApiService,
        useValue: {
          getHistory: () => Promise.resolve({ data: [], total: 0, page: 1, limit: 25 }),
        } as unknown as SubtitlesApiService,
      },
    ],
  });
  return TestBed.createComponent(SubtitlesActivityComponent).componentInstance;
}

describe('SubtitlesActivityComponent.errorText', () => {
  it('resolves a translation key and passes a raw engine error through', () => {
    const page = setup();
    expect(page.errorText(entry('activity.subtitle_error_interrupted'))).toBe('Interrupted');
    expect(page.errorText(entry('tesseract: exit 1'))).toBe('tesseract: exit 1');
  });

  it('reports no detail for an entry without a message', () => {
    const page = setup();
    expect(page.errorText(entry(null))).toBe('');
    expect(page.errorText(entry('  '))).toBe('');
  });
});
