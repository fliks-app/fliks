import { Component, input, output, provideZonelessChangeDetection, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Episode, Media, Season } from '../../../core/services/api/media.service';
import { MediaService } from '../../../core/services/api/media.service';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { MediaCardComponent } from '../media-card/media-card';
import { MediaPickerComponent, type MediaPick, pickEpisodes } from './media-picker';

@Component({
  selector: 'app-media-card',
  template: `<button type="button" class="stub-card" (click)="clicked.emit()">{{ media()?.title }}</button>`,
})
class StubMediaCardComponent {
  readonly media = input<Media | null>(null);
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
const movie = { id: 3, title: 'Film', type: 'movie' } as Media;

@Component({
  imports: [MediaPickerComponent],
  template: `<app-media-picker [multiple]="multiple()" (picked)="out.push($event)" />`,
})
class Host {
  readonly picker = viewChild.required(MediaPickerComponent);
  readonly multiple = signal(true);
  readonly out: MediaPick[][] = [];
}

// Mirrors the subset of public/i18n/en.json the picker renders.
const en = {
  media_picker: { add_count_one: 'Add {{count}} episode', add_count_other: 'Add {{count}} episodes' },
  media_detail: { season_number: 'Season {{number}}', specials: 'Specials' },
};

describe('MediaPickerComponent', () => {
  let getAll: ReturnType<typeof vi.fn>;
  let getOne: ReturnType<typeof vi.fn>;
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

  it('emits one entry for a movie', async () => {
    await type('film');
    await click(root.querySelector('.stub-card'));
    expect(host.out).toEqual([[{ mediaId: 3, episodeId: null }]]);
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

    it('moves focus to the new view', async () => {
      expect(document.activeElement).toBe(root.querySelector('button[autofocus]'));
      await click(root.querySelector('button[autofocus]'));
      expect(document.activeElement).toBe(root.querySelector('input[type=search]'));
    });

    it('emits the episodes until the end of the season, in order, skipping files-less ones', async () => {
      await click(modeButton(1));
      await click(epButtons()[1]);
      expect(host.out.map(ids)).toEqual([[12, 13, 14]]);
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
      expect(root.querySelector('p.text-sm')).toBeNull();
      await click(confirm());
      expect(host.out.map(ids)).toEqual([[11, 12, 13, 14]]);
    });

    it('offers only "this episode" without `multiple`', async () => {
      host.multiple.set(false);
      await flush();
      expect(root.querySelector('[role=group]')).toBeNull();
      await click(epButtons()[2]);
      expect(host.out.map(ids)).toEqual([[13]]);
    });
  });

  it('keeps the last answered series when picks race', async () => {
    const a = deferred<Media>();
    const b = deferred<Media>();
    getOne.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await type('show');
    await click(root.querySelectorAll('.stub-card')[1]);
    await click(root.querySelector('button[autofocus]'));
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
