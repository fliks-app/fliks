import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import en from '../../../../../public/i18n/en.json';
import type { LastSearch } from '../../../core/services/api/last-search.model';
import { LastSearchComponent } from './last-search';

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const search = (over: Partial<LastSearch> = {}): LastSearch => ({
  at: hoursFromNow(-2),
  outcome: 'none',
  found: 14,
  eligible: 0,
  rejections: [],
  failed: [],
  nextAt: null,
  ...over,
});

function render(value: LastSearch | null | undefined): string | null {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of(en) } } }),
    ],
  });
  const fixture = TestBed.createComponent(LastSearchComponent);
  fixture.componentRef.setInput('search', value);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelector('[data-testid="last-search"]')?.textContent?.trim() ?? null;
}

describe('LastSearchComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders nothing for a server that sends no outcome', () => {
    expect(render(undefined)).toBeNull();
  });

  it('says a title was never searched', () => {
    expect(render(null)).toBe('Not searched yet.');
  });

  it('gives the top rejection reasons and the next search of a search that matched nothing', () => {
    const text = render(
      search({ rejections: [{ code: 'SIZE_TOO_LOW', count: 9 }, { code: 'LANGUAGE_NOT_ALLOWED', count: 5 }], nextAt: hoursFromNow(4) }),
    );
    expect(text).toBe('Searched 2 hours ago: 14 releases, none matched (9 too small, 5 wrong language). Next search in 4 hours.');
  });

  it('falls back to a generic label for an unknown code and drops reasons when there are none', () => {
    expect(render(search({ rejections: [{ code: 'FUTURE_CODE', count: 3 }] }))).toContain('(3 other reasons)');
    TestBed.resetTestingModule();
    expect(render(search({ found: 1 }))).toBe('Searched 2 hours ago: 1 release, none matched.');
  });

  it('reports a search that found nothing at all', () => {
    expect(render(search({ found: 0 }))).toBe('Searched 2 hours ago: no releases found.');
  });

  it('says a release was found', () => {
    expect(render(search({ outcome: 'grabbed', found: 3, eligible: 1 }))).toBe('Found 2 hours ago.');
  });

  it('says a source did not answer, and names the failed sources', () => {
    expect(render(search({ outcome: 'timed_out', failed: ['Indexer A'] }))).toBe(
      'Searched 2 hours ago. A source did not answer, trying again later. Indexer A did not answer.',
    );
  });

  it('does not announce a next search that is already due', () => {
    expect(render(search({ nextAt: hoursFromNow(-1) }))).not.toContain('Next search');
  });
});
