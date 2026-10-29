import { Component, input, output, provideZonelessChangeDetection, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Episode, Media, Season } from '../../../core/services/api/media.service';
import { MediaService } from '../../../core/services/api/media.service';
import { MetadataService } from '../../../core/services/api/metadata.service';
import { StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { MediaCardComponent } from '../media-card/media-card';
import { MediaPickerComponent, type MediaPick, type TakenItem, pickEpisodes } from './media-picker';

@Component({
  selector: 'app-media-card',
  template: `<button type="button" class="stub-card" [attr.data-badge]="badge()" (click)="clicked.emit()">{{ media()?.title ?? title() }}</button>`,
})
class StubMediaCardComponent {
  readonly media = input<Media | null>(null);
  readonly imageUrl = input<string | null>(null);
  readonly title = input('');
  readonly subtitle = input<string | undefined>(undefined);
  readonly badge = input<string | null>(null);
  readonly status = input<string | null>(null);
  readonly selectOnly = input(false);
  readonly hideStatusBar = input(false);
  readonly posterMorph = input(true);
  readonly clicked = output<void>();
}

const ep = (id: number, n: number, extra: Partial<Episode> = {}): Episode =>
  ({ id, episodeNumber: n, title: `E${n}`, hasFile: true, ...extra }) as Episode;
const season = (seasonNumber: number, episodes: Episode[]) => ({ seasonNumber, episodes }) as Season;

const series: Media = {
  id: 7,
  title: 'Show',
  type: 'series',
  seasons: [
    season(1, [ep(13, 3), ep(11, 1), ep(12, 2), ep(14, 4), ep(15, 5, { hasFile: false })]),
    season(2, [ep(21, 1), ep(22, 2)]),
  ],
} as Media;
const movie = { id: 3, title: 'Film', type: 'movie', files: [{ id: 30 }] } as Media;
const missingMovie = { id: 4, title: 'Missing', type: 'movie', files: [] } as unknown as Media;

@Component({
  imports: [MediaPickerComponent],
  template: `<app-media-picker [multiple]="multiple()" [taken]="taken()" (picked)="out.push($event)" />`,
})
class Host {
  readonly picker = viewChild.required(MediaPickerComponent);
  readonly multiple = signal(true);
  readonly taken = signal<TakenItem[]>([]);
  readonly out: MediaPick[][] = [];
}

// jsdom ships neither: the synopsis observes its size, and the open row scrolls into view.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

// Mirrors the subset of public/i18n/en.json the picker renders.
const en = {
  media_picker: { add_count_one: 'Add {{count}} episode', add_count_other: 'Add {{count}} episodes' },
  media_detail: { season_number: 'Season {{number}}', specials: 'Specials' },
};

describe('MediaPickerComponent', () => {
  let getAll: ReturnType<typeof vi.fn>;
  let getOne: ReturnType<typeof vi.fn>;
  let getRecommendations: ReturnType<typeof vi.fn>;
  let getWatchedEpisodeIds: ReturnType<typeof vi.fn>;
  let overlay: { enter: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn>; height: () => number };
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;
  let host: Host;
  let root: HTMLElement;

  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
  };
  const type = async (q: string) => {
    const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = q;
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    await flush();
  };
  const click = async (el: Element | null | undefined) => {
    (el as HTMLElement).click();
    await flush();
  };
  const modeButton = (i: number) => root.querySelectorAll('[role=group] button')[i];
  const epButtons = () => Array.from(root.querySelectorAll<HTMLElement>('ul button'));
  const tabs = () => Array.from(root.querySelectorAll<HTMLElement>('[role=tab]'));
  const confirm = () => root.querySelector<HTMLElement>('.justify-end .btn-primary');
  const firstAction = () => root.querySelector<HTMLElement>('[data-picker-focus]');
  const collapse = () => click(root.querySelector('[data-picker-detail] .btn-square'));
  const ids = (out: MediaPick[]) => out.map((p) => p.episodeId);
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const openSeries = async () => {
    await type('show');
    await click(root.querySelectorAll('.stub-card')[1]);
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    getAll = vi.fn().mockResolvedValue({ data: [movie, series], total: 2 });
    getOne = vi.fn().mockResolvedValue(series);
    getRecommendations = vi.fn().mockResolvedValue([]);
    getWatchedEpisodeIds = vi.fn().mockResolvedValue([]);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    overlay = { enter: vi.fn(), leave: vi.fn(), height: () => 0 };
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of(en) } } }),
        { provide: MediaService, useValue: { getAll, getOne } },
        { provide: KeyboardOverlayService, useValue: overlay },
        { provide: StreamingApiService, useValue: { getRecommendations, getWatchedEpisodeIds } },
        { provide: MetadataService, useValue: { getMovieGenres: vi.fn().mockResolvedValue([{ id: 18, name: 'Drama' }]), getTvGenres: vi.fn().mockResolvedValue([]) } },
      ],
    });
    TestBed.overrideComponent(MediaPickerComponent, {
      remove: { imports: [MediaCardComponent] },
      add: { imports: [StubMediaCardComponent] },
    });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    root = fixture.nativeElement;
    document.body.append(root);
    fixture.detectChanges();
    host.picker().show();
    await flush();
  });

  afterEach(() => {
    root.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('searches once with the debounced query', async () => {
    const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
    for (const q of ['d', 'du', 'dune']) {
      input.value = q;
      input.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(getAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(getAll).toHaveBeenCalledExactlyOnceWith({ q: 'dune', limit: 24 });
  });

  it('ignores a search answered after the dialog was reopened', async () => {
    const late = deferred<{ data: Media[]; total: number }>();
    getAll.mockReturnValueOnce(late.promise);
    await type('film');
    host.picker().close();
    host.picker().show();
    await flush();
    late.resolve({ data: [movie], total: 1 });
    await flush();
    expect(root.querySelectorAll('.stub-card')).toHaveLength(0);
    expect(root.querySelector('.loading')).toBeNull();
  });

  it('opens a movie alone, with its synopsis, and emits it from Add', async () => {
    getOne.mockResolvedValue({ ...movie, overview: 'A plot.' });
    await type('film');
    await click(root.querySelector('.stub-card'));
    expect(host.out).toEqual([]);
    expect(root.querySelector('[data-picker-detail]')!.textContent).toContain('A plot.');
    expect(root.querySelectorAll('.stub-card')).toHaveLength(0);
    await click(firstAction());
    expect(host.out).toEqual([[{ mediaId: 3, episodeId: null, title: 'Film' }]]);
  });

  it('folds the open title back when the query changes', async () => {
    await type('film');
    await click(root.querySelector('.stub-card'));
    expect(root.querySelector('[data-picker-detail]')).not.toBeNull();
    await type('show');
    expect(root.querySelector('[data-picker-detail]')).toBeNull();
    expect(root.querySelectorAll('.stub-card').length).toBeGreaterThan(0);
  });

  it('checks a taken movie and refuses to add it again', async () => {
    host.taken.set([{ mediaId: 3, episodeId: null }]);
    getOne.mockResolvedValue(movie);
    await type('film');
    expect(root.querySelector('.stub-card')!.getAttribute('data-badge')).toBe('added');
    await click(root.querySelector('.stub-card'));
    expect((firstAction() as HTMLButtonElement).disabled).toBe(true);
  });

  it('suggests library titles while nothing is searched', async () => {
    getRecommendations.mockResolvedValue([
      { media: { id: 3, title: 'Film', type: 'movie', year: 2001, posterUrl: null, available: true } },
      { media: { id: 9, title: 'Gone', type: 'movie', year: 2001, posterUrl: null, available: false } },
    ]);
    host.picker().close();
    host.picker().show();
    await flush();
    expect(Array.from(root.querySelectorAll('.stub-card')).map((b) => b.textContent)).toEqual(['Film']);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('browses the library on a filter alone, by genre name', async () => {
    await flush();
    await click(Array.from(root.querySelectorAll<HTMLElement>('.badge')).find((b) => b.textContent!.trim() === 'Drama'));
    await vi.advanceTimersByTimeAsync(300);
    expect(getAll).toHaveBeenCalledWith({ q: '', limit: 24, genres: ['Drama'] });
  });

  it('leaves out a movie with no file and keeps a series', async () => {
    getAll.mockResolvedValue({ data: [missingMovie, movie, series], total: 3 });
    await type('film');
    expect(Array.from(root.querySelectorAll('.stub-card')).map((b) => b.textContent)).toEqual(['Film', 'Show']);
  });

  it('pairs keyboard enter and leave', async () => {
    host.picker().show();
    expect(overlay.enter).toHaveBeenCalledTimes(1);
    host.picker().close();
    expect(overlay.leave).toHaveBeenCalledTimes(1);
    host.picker().show();
    fixture.destroy();
    expect(overlay.enter).toHaveBeenCalledTimes(2);
    expect(overlay.leave).toHaveBeenCalledTimes(2);
  });

  describe('series', () => {
    beforeEach(openSeries);

    it('focuses the first action of the open row and folds it back into a card', async () => {
      expect(document.activeElement).toBe(firstAction());
      await collapse();
      expect(root.querySelector('[data-picker-detail]')).toBeNull();
      expect(root.querySelectorAll('.stub-card')).toHaveLength(2);
    });

    it('checks a taken episode and leaves it out of the season', async () => {
      host.taken.set([{ mediaId: 7, episodeId: 12 }]);
      await flush();
      expect((epButtons()[1] as HTMLButtonElement).disabled).toBe(true);
      await click(modeButton(2));
      await click(confirm());
      expect(host.out.map(ids)).toEqual([[11, 13, 14]]);
    });

    it('marks the episodes from the clicked one and adds them on confirm, skipping files-less ones', async () => {
      await click(modeButton(1));
      await click(epButtons()[1]);
      expect(host.out).toEqual([]);
      expect(epButtons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'true', 'true']);
      await click(confirm());
      expect(host.out.map(ids)).toEqual([[12, 13, 14]]);
    });

    it('drops the starting episode on a season change', async () => {
      await click(modeButton(1));
      await click(epButtons()[1]);
      await click(tabs()[1]);
      expect((confirm() as HTMLButtonElement).disabled).toBe(true);
    });

    it('keeps the ticks across seasons and emits them in season then episode order', async () => {
      await click(modeButton(3));
      for (const i of [3, 0]) await click(epButtons()[i]);
      await click(tabs()[1]);
      await click(epButtons()[1]);
      await click(epButtons()[0]);
      await click(tabs()[0]);
      expect(epButtons()[0].getAttribute('aria-pressed')).toBe('true');
      expect(confirm()!.textContent!.trim()).toBe('Add 4 episodes');
      await click(confirm());
      expect(host.out.map(ids)).toEqual([[11, 14, 21, 22]]);
    });

    it('labels the confirm button in the singular', async () => {
      await click(modeButton(3));
      await click(epButtons()[0]);
      expect(confirm()!.textContent!.trim()).toBe('Add 1 episode');
    });

    it('adds the whole season without a hint', async () => {
      await click(modeButton(2));
      expect(Array.from(root.querySelectorAll('p')).some((p) => p.textContent!.includes('hint_'))).toBe(false);
      await click(confirm());
      expect(host.out.map(ids)).toEqual([[11, 12, 13, 14]]);
    });

    it('offers only "this episode" without `multiple`', async () => {
      host.multiple.set(false);
      await flush();
      expect(root.querySelector('[role=group]')).toBeNull();
      await click(epButtons()[2]);
      expect(host.out).toEqual([]);
      await click(confirm());
      expect(host.out.map(ids)).toEqual([[13]]);
    });
  });

  it('marks watched episodes, and a season watched in full', async () => {
    getWatchedEpisodeIds.mockResolvedValue([12, 21, 22]);
    await openSeries();
    expect(epButtons().map((b) => !!b.querySelector('.badge-success'))).toEqual([false, true, false, false]);
    expect(tabs().map((t) => !!t.querySelector('svg'))).toEqual([false, true]);
  });

  it('keeps the last answered series when picks race', async () => {
    const a = deferred<Media>();
    const b = deferred<Media>();
    getOne.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await type('show');
    await click(root.querySelectorAll('.stub-card')[1]);
    await collapse();
    await click(root.querySelectorAll('.stub-card')[1]);
    b.resolve({ ...series, seasons: [season(1, [ep(31, 1)])] } as Media);
    await flush();
    a.resolve(series);
    await flush();
    expect(epButtons().map((e) => e.textContent!.trim())).toEqual(['1E1']);
  });

  it('shows a multi-episode file as one row labelled with its range', async () => {
    getOne.mockResolvedValue({
      ...series,
      seasons: [season(1, [ep(1, 1), ep(5, 5, { endEpisodeNumber: 6 }), ep(6, 6), ep(7, 7)])],
    });
    await openSeries();
    expect(epButtons().map((e) => e.querySelector('.badge')!.textContent!.trim())).toEqual(['1', '5-6', '7']);
  });

  it('sorts specials last and opens on the first real season', async () => {
    getOne.mockResolvedValue({ ...series, seasons: [season(0, [ep(90, 1)]), season(2, [ep(21, 1)]), season(1, [ep(11, 1)])] });
    await openSeries();
    expect(tabs().map((t) => t.textContent!.trim())).toEqual(['Season 1', 'Season 2', 'Specials']);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
  });
});

describe('pickEpisodes', () => {
  const eps = [ep(1, 1), ep(2, 2), ep(3, 3)];
  it('this: the anchor only', () => expect(pickEpisodes('this', eps, 2, new Set()).map((e) => e.id)).toEqual([2]));
  it('untilEnd: unknown anchor adds nothing', () => expect(pickEpisodes('untilEnd', eps, 9, new Set())).toEqual([]));
});
