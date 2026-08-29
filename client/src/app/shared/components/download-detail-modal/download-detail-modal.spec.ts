import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { DownloadDetailModalComponent } from './download-detail-modal';
import {
  DownloadLeaf,
  LeafKey,
  MediaDownloadProgress,
} from '../../../core/services/download-progress.service';

async function render(
  seasons: [number, [LeafKey, DownloadLeaf][]][],
): Promise<ComponentFixture<DownloadDetailModalComponent>> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
    ],
  });
  const fixture = TestBed.createComponent(DownloadDetailModalComponent);
  const progress: MediaDownloadProgress = {
    mediaId: 1,
    mediaType: 'series',
    percent: 50,
    state: 'active',
    dlspeed: 0,
    eta: 0,
    seasons: new Map(seasons.map(([n, l]) => [n, { leaves: new Map(l) }])),
  };
  fixture.componentRef.setInput('progress', progress);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

/**
 * One torrent, one row: bar, percent, speed and ETA. There is deliberately no
 * rollup above them — the media-level speed was whichever leaf ticked last, and
 * a folded state read "stalled" for a whole show whenever one episode was.
 */
describe('DownloadDetailModalComponent — one row per torrent', () => {
  it('gives every episode its own bar, speed and ETA', async () => {
    const f = await render([
      [1, [
        [6, { state: 'active', percent: 3, dlspeed: 1024, eta: 120 }],
        [8, { state: 'active', percent: 19, dlspeed: 2048, eta: 60 }],
      ]],
    ]);
    const [six, eight] = f.componentInstance.seasonRows()[0].leaves;

    expect(six.labelNumber).toBe(6);
    expect(six.percent).toBe(3);
    expect(six.stateLabelKey).toBe('activity.tstatus_downloading');
    expect(six.speed).toBe('1.0 KB/s');
    expect(six.eta).toBeTruthy();
    expect(eight.percent).toBe(19);
    expect(eight.speed).toBe('2.0 KB/s');
  });

  it('states a stall — the row has no other way to explain itself', async () => {
    const f = await render([[1, [[7, { state: 'stalled', percent: 0 }]]]]);
    const [seven] = f.componentInstance.seasonRows()[0].leaves;

    expect(seven.stateLabelKey).toBe('activity.tstatus_stalled');
    expect(seven.speed).toBeNull();
    expect(seven.eta).toBeNull();
    expect(seven.percent).toBe(0);
  });

  it('names the search, with no percentage, before a torrent exists', async () => {
    const f = await render([[1, [[8, { state: 'searching', percent: 0 }]]]]);
    const [row] = f.componentInstance.seasonRows()[0].leaves;

    expect(row.percent).toBeNull();
    expect(row.stateLabelKey).toBe('activity.tstatus_searching');
  });

  it('groups rows under every season in flight', async () => {
    const f = await render([
      [2, [['PACK', { state: 'active', percent: 20 }]]],
      [1, [[8, { state: 'active', percent: 50 }]]],
    ]);

    expect(f.componentInstance.seasonRows().map((s) => s.seasonNumber)).toEqual([1, 2]);
  });

  // A movie has one torrent and no season to group it under, so the headline is
  // the row rather than a rollup over anything.
  it('keeps a single headline for a movie', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
      ],
    });
    const fixture = TestBed.createComponent(DownloadDetailModalComponent);
    fixture.componentRef.setInput('progress', {
      mediaId: 1,
      mediaType: 'movie',
      percent: 42,
      state: 'active',
      dlspeed: 1024,
      eta: 60,
    } satisfies MediaDownloadProgress);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.isSingleTorrent()).toBe(true);
    expect(fixture.componentInstance.seasonRows()).toEqual([]);
    expect(fixture.componentInstance.speedLabel()).toBe('1.0 KB/s');
  });
});
