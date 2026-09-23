import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { LiveTvGroupLabelPipe } from './live-tv-group-label.pipe';

describe('LiveTvGroupLabelPipe', () => {
  function pipe() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({
          lang: 'en',
          loader: {
            provide: TranslateLoader,
            useValue: { getTranslation: () => of({ liveTv: { ungrouped: 'Ungrouped' } }) },
          },
        }),
        LiveTvGroupLabelPipe,
      ],
    });
    return TestBed.inject(LiveTvGroupLabelPipe);
  }

  it('VERDICT: translates the ungrouped sentinel instead of showing it raw', () => {
    expect(pipe().transform('__livetv_ungrouped__')).toBe('Ungrouped');
  });

  it('translates a null/empty group the same way', () => {
    const p = pipe();
    expect(p.transform(null)).toBe('Ungrouped');
    expect(p.transform('')).toBe('Ungrouped');
  });

  it('leaves a real group name untouched', () => {
    expect(pipe().transform('News')).toBe('News');
  });
});
