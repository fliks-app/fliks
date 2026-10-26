import { Component, input, output, provideZonelessChangeDetection, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Episode, Media } from '../../../core/services/api/media.service';
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
  readonly clickIntent = input('open');
  readonly hideStatusBar = input(false);
  readonly posterMorph = input(true);
  readonly clicked = output<void>();
}

const ep = (id: number, n: number, hasFile = true): Episode =>
  ({ id, episodeNumber: n, title: `E${n}`, hasFile }) as Episode;

const series: Media = {
  id: 7,
  title: 'Show',
  type: 'series',
  seasons: [
    { seasonNumber: 1, episodes: [ep(13, 3), ep(11, 1), ep(12, 2), ep(14, 4), ep(15, 5, false)] },
    { seasonNumber: 2, episodes: [ep(21, 1)] },
  ],
} as Media;
const movie = { id: 3, title: 'Film', type: 'movie' } as Media;

@Component({
  imports: [MediaPickerComponent],
  template: `<app-media-picker multiple (picked)="out.push($event)" />`,
})
class Host {
  readonly picker = viewChild.required(MediaPickerComponent);
  readonly out: MediaPick[][] = [];
}

describe('MediaPickerComponent', () => {
  let getAll: ReturnType<typeof vi.fn>;
  let getOne: ReturnType<typeof vi.fn>;
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
  const modeButton = (i: number) => root.querySelectorAll('[role=radio]')[i];
  const epButtons = () => Array.from(root.querySelectorAll<HTMLElement>('ul button'));

  beforeEach(async () => {
    vi.useFakeTimers();
    getAll = vi.fn().mockResolvedValue({ data: [movie, series], total: 2 });
    getOne = vi.fn().mockResolvedValue(series);
    HTMLDialogElement.prototype.showModal ??= function () {};
    HTMLDialogElement.prototype.close ??= function () {};
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService(),
        provideRouter([]),
        { provide: MediaService, useValue: { getAll, getOne } },
        { provide: KeyboardOverlayService, useValue: { enter: vi.fn(), leave: vi.fn() } },
      ],
    });
    TestBed.overrideComponent(MediaPickerComponent, {
      remove: { imports: [MediaCardComponent] },
      add: { imports: [StubMediaCardComponent] },
    });
    const fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    root = fixture.nativeElement;
    fixture.detectChanges();
    host.picker().show();
    await flush();
  });

  afterEach(() => vi.useRealTimers());

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

  it('emits one entry for a movie', async () => {
    await type('film');
    await click(root.querySelector('.stub-card'));
    expect(host.out).toEqual([[{ mediaId: 3, episodeId: null }]]);
  });

  describe('series', () => {
    beforeEach(async () => {
      await type('show');
      await click(root.querySelectorAll('.stub-card')[1]);
    });

    it('emits the episodes until the end of the season, in order, skipping files-less ones', async () => {
      await click(modeButton(1));
      await click(epButtons()[1]);
      expect(host.out).toEqual([[12, 13, 14].map((episodeId) => ({ mediaId: 7, episodeId }))]);
    });

    it('keeps the episode order whatever the tick order', async () => {
      await click(modeButton(3));
      for (const i of [3, 0, 2]) await click(epButtons()[i]);
      await click(root.querySelector('.btn-primary:not([role=radio])'));
      expect(host.out).toEqual([[11, 13, 14].map((episodeId) => ({ mediaId: 7, episodeId }))]);
    });

    it('adds the whole season', async () => {
      await click(modeButton(2));
      await click(root.querySelector('.btn-primary:not([role=radio])'));
      expect(host.out[0].map((p) => p.episodeId)).toEqual([11, 12, 13, 14]);
    });
  });
});

describe('pickEpisodes', () => {
  const eps = [ep(1, 1), ep(2, 2), ep(3, 3)];
  it('this: the anchor only', () => expect(pickEpisodes('this', eps, 2, new Set()).map((e) => e.id)).toEqual([2]));
  it('untilEnd: unknown anchor adds nothing', () => expect(pickEpisodes('untilEnd', eps, 9, new Set())).toEqual([]));
});
