import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it } from 'vitest';
import { SKIP_ERROR_TOAST } from '../../core/interceptors/error.interceptor';
import type { WantedRow } from '../../core/services/api/wants-api.service';
import { bookSpecProviders } from '../media-detail/book/book-test-setup';
import { WantedComponent } from './wanted';

const row = (id: number, title: string): WantedRow => ({
  mediaId: id, type: 'book', title, year: 2027, posterUrl: null, releaseDate: '2027-01-01',
  family: 'text', language: 'fr', wantId: id, lastSearch: null,
});

describe('WantedComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function setup() {
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    const fixture = TestBed.createComponent(WantedComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { fixture, http, settle, el: fixture.nativeElement as HTMLElement };
  }

  it('lists the wanted rows and pages on demand', async () => {
    const { http, settle, el } = await setup();
    http.expectOne((r) => r.url === '/api/wanted' && r.params.get('page') === '1').flush({
      data: [row(1, 'Alpha')],
      total: 2,
    });
    await settle();
    expect(el.querySelectorAll('[data-testid="wanted-row"]')).toHaveLength(1);
    (el.querySelector('[data-testid="wanted-more"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.url === '/api/wanted' && r.params.get('page') === '2').flush({
      data: [row(2, 'Beta')],
      total: 2,
    });
    await settle();
    expect(el.querySelectorAll('[data-testid="wanted-row"]')).toHaveLength(2);
    expect(el.querySelector('[data-testid="wanted-more"]')).toBeNull();
  });

  it('shows the age and the eligible share of the last search, or that none ran', async () => {
    const { http, settle, el } = await setup();
    TestBed.inject(TranslateService).setTranslation('en', { wanted: { not_searched: 'Not yet', last_search: '{{eligible}} of {{found}}' } });
    const searched: WantedRow = {
      ...row(2, 'Beta'),
      lastSearch: { at: new Date(Date.now() - 2 * 3600_000).toISOString(), outcome: 'none', found: 14, eligible: 0, rejections: [], failed: [], nextAt: null },
    };
    http.expectOne('/api/wanted?page=1&limit=25').flush({ data: [row(1, 'Alpha'), searched], total: 2 });
    await settle();
    const cells = [...el.querySelectorAll('[data-testid="wanted-last-search"]')].map((c) => c.textContent?.trim());
    expect(cells[0]).toBe('Not yet');
    expect(cells[1]).toBe('0 of 14');
  });

  it('asks again with the kind filter and shows the empty state', async () => {
    const { http, settle, el } = await setup();
    http.expectOne('/api/wanted?page=1&limit=25').flush({ data: [row(1, 'Alpha')], total: 1 });
    await settle();
    (el.querySelectorAll('[data-testid="wanted-filters"] button')[3] as HTMLButtonElement).click();
    const req = http.expectOne((r) => r.url === '/api/wanted' && r.params.get('type') === 'book');
    req.flush({ data: [], total: 0 });
    await settle();
    expect(el.querySelector('[data-testid="wanted-empty"]')).not.toBeNull();
  });

  it('shows one failed state with a retry, and no error toast on the first load', async () => {
    const { http, settle, el } = await setup();
    const first = http.expectOne((r) => r.url === '/api/wanted');
    expect(first.request.context.get(SKIP_ERROR_TOAST)).toBe(true);
    first.flush('x', { status: 500, statusText: 'Server Error' });
    await settle();
    expect(el.querySelector('app-load-failed')).not.toBeNull();
    (el.querySelector('app-load-failed button') as HTMLButtonElement).click();
    http.expectOne((r) => r.url === '/api/wanted').flush({ data: [row(1, 'Alpha')], total: 1 });
    await settle();
    expect(el.querySelector('app-load-failed')).toBeNull();
    expect(el.querySelectorAll('[data-testid="wanted-row"]')).toHaveLength(1);
  });
});
