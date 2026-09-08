import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { SubtitleStatusPipe } from './subtitle-status.pipe';

const table = {
  activity: { status_downloaded: 'Téléchargé', status_synced: 'Synchronisé' },
  requests: { status: { processing: 'En traitement' } },
};

function pipe() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'fr',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of(table) } },
      }),
      SubtitleStatusPipe,
    ],
  });
  return TestBed.inject(SubtitleStatusPipe);
}

describe('SubtitleStatusPipe', () => {
  it('resolves a status to the label its own feature already ships', () => {
    const p = pipe();
    expect(p.transform('downloaded')).toBe('Téléchargé');
    expect(p.transform('processing')).toBe('En traitement');
  });

  it('falls through to the raw value rather than emptying the cell', () => {
    const p = pipe();
    expect(p.transform('something_new')).toBe('something_new');
    expect(p.transform(null)).toBe('');
  });
});
