import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { WantedRow } from '../../core/services/api/wants-api.service';
import { bookSpecProviders } from '../media-detail/book/book-test-setup';
import { WantedComponent } from './wanted';

const row = (id: number, title: string): WantedRow => ({
  mediaId: id, type: 'book', title, year: 2027, posterUrl: null, releaseDate: '2027-01-01',
  family: 'text', language: 'fr', wantId: id,
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
});
