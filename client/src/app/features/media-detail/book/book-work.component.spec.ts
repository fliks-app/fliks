import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../../../core/services/auth.service';
import {
  bookChaptersFixture, bookDetailFixture, bookSourcesFixture, collectionDetailFixture, personWorksFixture,
  textEditionFixture,
} from '../../../core/services/api/books.fixtures';
import type { BookDetail } from '../../../core/services/api/books.models';
import type { Media } from '../../../core/services/api/media.service';
import { BookWorkComponent } from './book-work.component';
import { BookWorksRowComponent, type WorkItem } from './book-works-row.component';
import { bookSpecProviders } from './book-test-setup';
import type { BookMedia } from './book-media';

@Component({ selector: 'app-book-works-row', template: '' })
class RowStub {
  readonly heading = input('');
  readonly items = input<WorkItem[]>([]);
  readonly currentId = input<number | null>(null);
}

function bookMedia(book: Partial<BookDetail> = {}): BookMedia {
  return { id: 1, type: 'book', title: 'Book One', overview: '', posterUrl: null, book: { ...bookDetailFixture, ...book } } as unknown as Media & { book: BookDetail };
}

describe('BookWorkComponent', () => {
  async function setup(book: Partial<BookDetail> = {}, canEdit = false) {
    TestBed.configureTestingModule({
      providers: bookSpecProviders({
        provide: AuthService,
        useValue: { hasPermission: (p: string) => canEdit && p === 'media.edit' },
      }),
    });
    TestBed.overrideComponent(BookWorkComponent, {
      remove: { imports: [BookWorksRowComponent] },
      add: { imports: [RowStub] },
    });
    const fixture = TestBed.createComponent(BookWorkComponent);
    fixture.componentRef.setInput('media', bookMedia(book));
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    return { fixture, http, el: fixture.nativeElement as HTMLElement };
  }

  async function settle(fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('shows the hero: title, author links, volume of series with previous and next', async () => {
    const { fixture, http, el } = await setup();
    http.expectOne('/api/collections/10').flush(collectionDetailFixture);
    http.expectOne('/api/persons/1/works?role=author').flush(personWorksFixture);
    http.expectOne('/api/media/1/editions/101/chapters').flush(bookChaptersFixture);
    await settle(fixture);

    expect(el.querySelector('h1')!.textContent).toBe('Book One');
    expect(el.querySelector('[data-testid="authors"] a')!.getAttribute('href')).toBe('/persons/1?role=author');
    expect(el.querySelector('[data-testid="narrators"] a')!.getAttribute('href')).toBe('/persons/2?role=narrator');
    const series = el.querySelector('[data-testid="series"]')!;
    expect(series.querySelector('a')!.getAttribute('href')).toBe('/collections/10');
    expect(series.querySelector('[data-testid="previous"]')).toBeNull();
    expect(series.querySelector('[data-testid="next"]')!.getAttribute('href')).toBe('/books/2');
  });

  it('puts the family last played first and keeps both format buttons disabled', async () => {
    const { fixture, http, el } = await setup();
    http.expectOne('/api/collections/10').flush(collectionDetailFixture);
    http.expectOne('/api/persons/1/works?role=author').flush(personWorksFixture);
    http.expectOne('/api/media/1/editions/101/chapters').flush([]);
    await settle(fixture);
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid="format-button"]'));
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(['books_work.listen', 'books_work.read']);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(buttons[0].classList).toContain('btn-primary');
    expect(el.textContent).toContain('books_work.progress');
  });

  it('fills the series row with its entries and the author row without the work itself', async () => {
    const { fixture, http, el } = await setup();
    http.expectOne('/api/collections/10').flush(collectionDetailFixture);
    http.expectOne('/api/persons/1/works?role=author').flush(personWorksFixture);
    http.expectOne('/api/media/1/editions/101/chapters').flush([]);
    await settle(fixture);
    await settle(fixture);

    const rows = fixture.debugElement.queryAll((d) => d.name === 'app-book-works-row').map((d) => d.componentInstance as RowStub);
    expect(rows.map((r) => r.heading())).toEqual(['books_work.row_series', 'books_work.row_author']);
    expect(rows.map((r) => r.items().map((i) => i.id))).toEqual([[1, 3], [4]]);
    expect(rows[0].currentId()).toBe(1);
    expect(el.querySelectorAll('app-book-works-row')).toHaveLength(2);
  });

  it('asks for no row and no chapters without a series, an author or an audio file', async () => {
    const { fixture, http, el } = await setup({ series: [], authors: [], editions: [textEditionFixture], progress: null });
    await settle(fixture);
    http.verify();
    expect(el.querySelector('app-book-works-row')).toBeNull();
    expect(el.querySelector('[data-testid="authors"]')).toBeNull();
    expect(Array.from(el.querySelectorAll('[data-testid="format-button"]'))).toHaveLength(1);
  });

  it('mentions unofficial sources only when a field comes from one', async () => {
    const plain = await setup({ series: [], authors: [], editions: [textEditionFixture] });
    expect(plain.el.querySelector('[data-testid="unofficial"]')).toBeNull();

    TestBed.resetTestingModule();
    const flagged = await setup({
      series: [], authors: [],
      editions: [{ ...textEditionFixture, fieldSources: [{ field: 'duration', provider: 'audnexus', locked: false }] }],
    });
    expect(flagged.el.querySelector('[data-testid="unofficial"]')).not.toBeNull();
  });

  it('shows the Sources panel to editors only', async () => {
    const viewer = await setup({ series: [], authors: [], editions: [textEditionFixture] });
    viewer.http.verify();
    expect(viewer.el.querySelector('app-book-sources')).toBeNull();

    TestBed.resetTestingModule();
    const editor = await setup({ series: [], authors: [], editions: [textEditionFixture] }, true);
    editor.http.expectOne('/api/media/1/sources').flush(bookSourcesFixture);
    expect(editor.el.querySelector('app-book-sources')).not.toBeNull();
  });
});
