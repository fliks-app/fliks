import { Component, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../core/services/auth.service';
import { SseService } from '../../../core/services/sse.service';
import { Subject } from 'rxjs';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { DownloadManagerService } from '../../../core/services/download-manager.service';
import { StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { PlayableMediaService } from '../../../core/services/playable-media.service';
import { PlaybackQueueService } from '../../../core/services/playback-queue.service';
import {
  bookChaptersFixture, bookDetailFixture, bookSourcesFixture, collectionDetailFixture, personWorksFixture,
  textEditionFixture,
} from '../../../testing/books.fixtures';
import type { BookDetail } from '../../../core/services/api/books.models';
import type { Media } from '../../../core/services/api/media.service';
import { BookWorkComponent } from './book-work.component';
import { BookWorksRowComponent, type WorkItem } from './book-works-row.component';
import { bookSpecProviders } from './book-test-setup';
import type { BookMedia } from '../../../core/services/api/book-media';

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
  const play = vi.fn();

  async function setup(book: Partial<BookDetail> = {}, canEdit = false) {
    play.mockClear();
    TestBed.configureTestingModule({
      providers: bookSpecProviders(
        { provide: AuthService, useValue: { user: () => null, hasPermission: (p: string) => canEdit && p === 'media.edit' } },
        { provide: SseService, useValue: { likeEvents: new Subject() } },
        { provide: AudioPlayerService, useValue: { play } },
        { provide: PlayableMediaService, useValue: {} },
        { provide: StreamingApiService, useValue: {} },
        { provide: DownloadManagerService, useValue: { tasks: signal([]) } },
      ),
    });
    TestBed.overrideComponent(BookWorkComponent, {
      remove: { imports: [BookWorksRowComponent] },
      add: { imports: [RowStub] },
    });
    const fixture = TestBed.createComponent(BookWorkComponent);
    fixture.componentRef.setInput('media', bookMedia(book));
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.match('/api/email-devices').forEach((r) => r.flush({ enabled: false, canSend: false, maxBytes: null, devices: [] }));
    http.match('/api/likes/state/1').forEach((r) => r.flush({ media: false, seasonIds: [], episodeIds: [] }));
    http.match('/api/media/1/similar').forEach((r) => r.flush([{ id: 7, title: 'Book Seven', year: 2001, posterUrl: null, rating: null, genres: [], hasFile: true }]));
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

  it('plays the audio edition and queues the series from this volume', async () => {
    const { fixture, http, el } = await setup();
    http.expectOne('/api/collections/10').flush(collectionDetailFixture);
    http.expectOne('/api/persons/1/works?role=author').flush(personWorksFixture);
    http.expectOne('/api/media/1/editions/101/chapters').flush([]);
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('[data-testid="format-button"]')!.click();
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ mediaId: 1, itemId: 1001, title: 'Book One' }));
    const queue = TestBed.inject(PlaybackQueueService);
    expect(queue.source()).toBe('series');
    expect(queue.current()?.mediaId).toBe(1);
    expect(queue.autoplay()).toBe(true);
  });

  it('puts the family last played first, the listen button enabled and the read button a link to the reader', async () => {
    const { fixture, http, el } = await setup();
    http.expectOne('/api/collections/10').flush(collectionDetailFixture);
    http.expectOne('/api/persons/1/works?role=author').flush(personWorksFixture);
    http.expectOne('/api/media/1/editions/101/chapters').flush([]);
    await settle(fixture);
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid="format-button"]'));
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(['books_work.continue_listening', 'books_work.read']);
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].getAttribute('href')).toBe('/read/1/1000');
    expect(buttons[0].classList).toContain('btn-primary');
    expect(el.querySelector<HTMLElement>('app-hero-progress .bg-primary')!.style.width).toBe('25%');
    expect(el.querySelector('app-hero-progress')!.textContent).toContain('media_info.remaining');
  });

  it('renders the title and cover from a card handoff before the editions arrive', async () => {
    TestBed.configureTestingModule({
      providers: bookSpecProviders(
        { provide: AuthService, useValue: { user: () => null, hasPermission: () => false } },
        { provide: SseService, useValue: { likeEvents: new Subject() } },
        { provide: AudioPlayerService, useValue: { play } },
        { provide: PlayableMediaService, useValue: {} },
        { provide: StreamingApiService, useValue: {} },
        { provide: DownloadManagerService, useValue: { tasks: signal([]) } },
      ),
    });
    const fixture = TestBed.createComponent(BookWorkComponent);
    fixture.componentRef.setInput('media', { id: 1, type: 'book', title: 'Book One', posterUrl: '/p.jpg' } as unknown as Media);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')!.textContent).toBe('Book One');
    expect(el.querySelector('[data-testid="format-button"]')).toBeNull();
    expect(el.querySelector('app-book-editions')).toBeNull();
  });

  it('fills the series row with its entries and the author row without the work itself', async () => {
    const { fixture, http, el } = await setup();
    http.expectOne('/api/collections/10').flush(collectionDetailFixture);
    http.expectOne('/api/persons/1/works?role=author').flush(personWorksFixture);
    http.expectOne('/api/media/1/editions/101/chapters').flush([]);
    await settle(fixture);
    await settle(fixture);

    const rows = fixture.debugElement.queryAll((d) => d.name === 'app-book-works-row').map((d) => d.componentInstance as RowStub);
    expect(rows.map((r) => r.heading())).toEqual(['books_work.row_series', 'books_work.row_author', 'books_work.row_similar']);
    expect(rows.map((r) => r.items().map((i) => i.id))).toEqual([[1, 3], [4], [7]]);
    expect(rows[0].currentId()).toBe(1);
    expect(el.querySelectorAll('app-book-works-row')).toHaveLength(3);
  });

  it('asks for no row and no chapters without a series, an author or an audio file', async () => {
    const { fixture, http, el } = await setup({ series: [], authors: [], editions: [textEditionFixture], progress: null });
    await settle(fixture);
    http.verify();
    expect(el.querySelectorAll('app-book-works-row')).toHaveLength(1);
    expect(el.querySelector('[data-testid="authors"]')).toBeNull();
    expect(Array.from(el.querySelectorAll('[data-testid="format-button"]'))).toHaveLength(1);
  });

  it('offers the Sources and wants dialogs to editors only, loaded when opened', async () => {
    const viewer = await setup({ series: [], authors: [], editions: [textEditionFixture] });
    viewer.http.verify();
    expect(viewer.el.querySelector('[data-testid="sources-dialog"]')).toBeNull();

    TestBed.resetTestingModule();
    const editor = await setup({ series: [], authors: [], editions: [textEditionFixture] }, true);
    editor.http.verify();
    expect(editor.el.querySelectorAll('[data-testid$="-dialog"]')).toHaveLength(2);
    expect(editor.el.querySelector('app-book-sources')).toBeNull();
  });
});
