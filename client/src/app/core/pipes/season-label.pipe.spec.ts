import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { SeasonLabelPipe } from './season-label.pipe';

describe('SeasonLabelPipe', () => {
  function pipe() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({
          lang: 'en',
          loader: {
            provide: TranslateLoader,
            useValue: {
              getTranslation: () =>
                of({
                  media_detail: {
                    specials: 'Specials',
                    season_number: 'Season {{number}}',
                  },
                }),
            },
          },
        }),
        SeasonLabelPipe,
      ],
    });
    return TestBed.inject(SeasonLabelPipe);
  }

  it('VERDICT: names season 0 the specials instead of "Season 0"', () => {
    expect(pipe().transform(0)).toBe('Specials');
  });

  it('numbers every other season', () => {
    expect(pipe().transform(3)).toBe('Season 3');
  });
});
