import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { describe, expect, it, vi } from 'vitest';
import { bookDetailFixture, personWorksFixture } from '../../../testing/books.fixtures';
import { BookSeriesFormComponent } from './book-series-form.component';
import { bookSpecProviders } from './book-test-setup';

describe('BookSeriesFormComponent', () => {
  async function setup(series: (typeof bookDetailFixture.series)[number] | null = bookDetailFixture.series[0], works = personWorksFixture, all: { id: number; name: string }[] = []) {
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    const fixture = TestBed.createComponent(BookSeriesFormComponent);
    fixture.componentRef.setInput('mediaId', 1);
    fixture.componentRef.setInput('series', series);
    fixture.componentRef.setInput('authorIds', [5]);
    const done = vi.fn();
    fixture.componentInstance.done.subscribe(done);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((r) => r.url === '/api/persons/5/works').flush(works);
    const req = http.expectOne((r) => r.url === '/api/collections');
    expect(req.request.params.get('kind')).toBe('book');
    req.flush(all);
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const select = () => el.querySelector('select') as HTMLSelectElement | null;
    const choose = (value: string) => {
      select()!.value = value;
      select()!.dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };
    const input = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
    return { fixture, http, el, input, select, choose, done };
  }

  it('prefills the current series and lists the series of the authors', async () => {
    const { el, input, select } = await setup();
    expect(select()!.value).toBe('10');
    expect(Array.from(select()!.options).map((o) => o.textContent?.trim())).toEqual(['Series One', 'books_work.series_new']);
    expect(el.querySelector('[data-testid="series-name"]')).toBeNull();
    expect(input('series-position').value).toBe('1');
  });

  it('saves the chosen existing series by id', async () => {
    const { fixture, http, input, done } = await setup();
    input('series-save').click();
    const req = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/media/1/series');
    expect(req.request.body).toEqual({ id: 10, position: '1' });
    req.flush({ series: null });
    await fixture.whenStable();
    expect(done).toHaveBeenCalled();
  });

  it('reveals the name input for a new series and saves it by name', async () => {
    const { fixture, http, input, choose } = await setup();
    choose('new');
    const name = input('series-name');
    name.value = 'Fresh Saga';
    name.dispatchEvent(new Event('input'));
    const position = input('series-position');
    position.value = 'Special';
    position.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    input('series-save').click();
    const req = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/media/1/series');
    expect(req.request.body).toEqual({ name: 'Fresh Saga', position: 'Special' });
    req.flush({ series: null });
  });

  it('shows the name input directly when the authors have no series', async () => {
    const { el, input } = await setup(null, { ...personWorksFixture, series: [] });
    expect(el.querySelector('select')).toBeNull();
    expect(input('series-save').disabled).toBe(true);
  });

  it('lists every book series, the authors first, when the authors have none', async () => {
    const { select } = await setup(null, { ...personWorksFixture, series: [] }, [
      { id: 31, name: 'Zeta' },
      { id: 30, name: 'Alpha' },
    ]);
    expect(Array.from(select()!.options).map((o) => o.textContent?.trim())).toEqual(['Alpha', 'Zeta', 'books_work.series_new']);
  });

  it('removes the book from its series', async () => {
    const { fixture, http, input, done } = await setup();
    input('series-remove').click();
    http.expectOne((r) => r.method === 'DELETE' && r.url === '/api/media/1/series').flush({ series: null });
    await fixture.whenStable();
    expect(done).toHaveBeenCalled();
  });

  it('keeps the form usable when the save fails', async () => {
    const { fixture, http, input, done } = await setup();
    input('series-save').click();
    http.expectOne((r) => r.method === 'PUT').flush('no', { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(done).not.toHaveBeenCalled();
    expect(input('series-save').disabled).toBe(false);
  });

  it('offers the providers series back only while the series is locked', async () => {
    const { fixture, http, el, input, done } = await setup();
    expect(el.querySelector('[data-testid="series-reset"]')).toBeNull();
    fixture.componentRef.setInput('locked', true);
    fixture.detectChanges();
    input('series-reset').click();
    http.expectOne((r) => r.method === 'POST' && r.url === '/api/media/1/series/reset').flush({ series: null });
    await fixture.whenStable();
    expect(done).toHaveBeenCalled();
  });
});
