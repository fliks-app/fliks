import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { describe, expect, it, vi } from 'vitest';
import { bookDetailFixture, personWorksFixture } from '../../../testing/books.fixtures';
import { BookSeriesFormComponent } from './book-series-form.component';
import { bookSpecProviders } from './book-test-setup';

describe('BookSeriesFormComponent', () => {
  async function setup(series: (typeof bookDetailFixture.series)[number] | null = bookDetailFixture.series[0]) {
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    const fixture = TestBed.createComponent(BookSeriesFormComponent);
    fixture.componentRef.setInput('mediaId', 1);
    fixture.componentRef.setInput('series', series);
    fixture.componentRef.setInput('authorIds', [5]);
    const done = vi.fn();
    fixture.componentInstance.done.subscribe(done);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((r) => r.url === '/api/persons/5/works').flush(personWorksFixture);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const input = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
    return { fixture, http, el, input, done };
  }

  it('prefills the current series and suggests the series of the authors', async () => {
    const { fixture, el, input } = await setup();
    expect(input('series-name').value).toBe('Series One');
    expect(input('series-position').value).toBe('1');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(Array.from(el.querySelectorAll('datalist option')).map((o) => o.getAttribute('value'))).toEqual(['Series One']);
    });
  });

  it('saves a typed series and position, then reports done', async () => {
    const { fixture, http, input, done } = await setup(null);
    const name = input('series-name');
    name.value = 'Fresh Saga';
    name.dispatchEvent(new Event('input'));
    const position = input('series-position');
    position.value = 'Special';
    position.dispatchEvent(new Event('input'));
    http.expectOne((r) => r.url === '/api/collections' && r.params.get('q') === 'Fresh Saga').flush([]);
    fixture.detectChanges();
    input('series-save').click();
    const req = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/media/1/series');
    expect(req.request.body).toEqual({ name: 'Fresh Saga', position: 'Special' });
    req.flush({ series: null });
    await fixture.whenStable();
    expect(done).toHaveBeenCalled();
  });

  it('removes the book from its series', async () => {
    const { fixture, http, input, done } = await setup();
    input('series-remove').click();
    http.expectOne((r) => r.method === 'DELETE' && r.url === '/api/media/1/series').flush({ series: null });
    await fixture.whenStable();
    expect(done).toHaveBeenCalled();
  });
});
