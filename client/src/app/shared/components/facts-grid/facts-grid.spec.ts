import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { FactsGridComponent, type Fact } from './facts-grid';

function render(facts: Fact[]) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
    ],
  });
  const fixture = TestBed.createComponent(FactsGridComponent);
  fixture.componentRef.setInput('facts', facts);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('FactsGridComponent', () => {
  it('draws each fact with a value, a key label translated and a proper name left as is', () => {
    const el = render([
      { label: 'discover.preview_countries', value: 'France' },
      { label: 'TMDB', translate: false, value: 42 },
    ]);
    const rows = Array.from(el.querySelectorAll('dt')).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent?.trim()]);
    expect(rows).toEqual([['discover.preview_countries', 'France'], ['TMDB', '42']]);
  });

  it('skips a fact with no value, and draws nothing when none has one', () => {
    const el = render([
      { label: 'a', value: null },
      { label: 'b', value: '' },
      { label: 'c', value: undefined },
    ]);
    expect(el.querySelector('dl')).toBeNull();
  });

  it('formats an amount as dollars', () => {
    const el = render([{ label: 'discover.preview_budget', value: 1500000, format: 'currency' }]);
    expect(el.querySelector('dd')?.textContent?.trim()).toBe('$1,500,000');
  });
});
