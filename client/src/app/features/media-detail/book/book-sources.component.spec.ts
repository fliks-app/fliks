import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { describe, expect, it } from 'vitest';
import { bookDetailFixture, bookSourcesFixture } from '../../../core/services/api/books.fixtures';
import { BookSourcesComponent } from './book-sources.component';
import { bookSpecProviders } from './book-test-setup';

describe('BookSourcesComponent', () => {
  async function setup() {
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    const fixture = TestBed.createComponent(BookSourcesComponent);
    fixture.componentRef.setInput('mediaId', 1);
    fixture.componentRef.setInput('editions', bookDetailFixture.editions);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/media/1/sources').flush(bookSourcesFixture);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (row: number, i: number) =>
      el.querySelectorAll('[data-testid="source-row"]')[row].querySelectorAll('button')[i] as HTMLButtonElement;
    return { fixture, http, el, button };
  }

  it('lists the work link and the edition identifiers', async () => {
    const { el } = await setup();
    const rows = Array.from(el.querySelectorAll('[data-testid="source-row"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('OL1W');
    expect(rows[1].textContent).toContain('9780000000002');
  });

  it('unlinks an identifier', async () => {
    const { fixture, http, button } = await setup();
    button(0, 1).click();
    const req = http.expectOne((r) => r.method === 'DELETE' && r.url === '/api/media/1/sources');
    expect(req.request.params.get('level')).toBe('work');
    expect(req.request.params.get('value')).toBe('OL1W');
    req.flush({ work: null, editions: bookSourcesFixture.editions });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="source-row"]').textContent).toContain('books_work.not_linked');
  });

  it('relinks through the form, then clears it', async () => {
    const { fixture, http, el, button } = await setup();
    button(1, 0).click();
    fixture.detectChanges();
    const input = el.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('9780000000002');
    input.value = '9780000000019';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    const req = http.expectOne((r) => r.method === 'PUT');
    expect(req.request.body).toEqual({ level: 'edition', editionId: 100, provider: 'isbn', value: '9780000000019' });
    req.flush(bookSourcesFixture);
    await fixture.whenStable();
    fixture.detectChanges();
    expect((el.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it('does not save an empty identifier', async () => {
    const { fixture, el } = await setup();
    expect((el.querySelector('form button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(fixture.componentInstance).toBeTruthy();
  });
});
