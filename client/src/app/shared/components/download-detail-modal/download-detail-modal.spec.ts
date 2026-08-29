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
import { ProgressPhase } from '../../../core/enums/download-progress-state.enum';

const leaf = (state: ProgressPhase, percent = 50): DownloadLeaf => ({ state, percent });

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
 * The modal stacks three levels — overall, per season, per torrent. With a
 * single torrent in flight they all carry the same words, so the breakdown is
 * replaced by one line naming the episode: the one thing the headline can't say.
 */
describe('DownloadDetailModalComponent — level de-duplication', () => {
  it('names the sole episode instead of repeating the state three times', async () => {
    const f = await render([[1, [[8, leaf('searching', 0)]]]]);

    expect(f.componentInstance.soleLeaf()).toEqual({
      seasonNumber: 1,
      labelKey: 'tracking.episode',
      labelNumber: 8,
    });
    expect(f.componentInstance.seasonRows()).toEqual([]);
  });

  it('keeps the breakdown once a season holds several torrents', async () => {
    const f = await render([[1, [[8, leaf('active', 50)], [9, leaf('active', 20)]]]]);

    expect(f.componentInstance.soleLeaf()).toBeNull();
    expect(f.componentInstance.seasonRows()[0].leaves.map((l) => l.labelNumber)).toEqual([8, 9]);
  });

  it('keeps the breakdown across several seasons', async () => {
    const f = await render([
      [1, [[8, leaf('active', 50)]]],
      [2, [['PACK', leaf('active', 20)]]],
    ]);

    expect(f.componentInstance.soleLeaf()).toBeNull();
    expect(f.componentInstance.seasonRows().map((s) => s.seasonNumber)).toEqual([1, 2]);
  });

  // `stalled` outranks `active`, so the stalled leaf is the one that agrees
  // with the season line and the downloading one is the exception.
  it('states a leaf only where it diverges from its season', async () => {
    const f = await render([[1, [[8, leaf('active', 50)], [9, leaf('stalled', 10)]]]]);
    const [diverging, same] = f.componentInstance.seasonRows()[0].leaves;

    expect(same.stateLabelKey).toBeNull();
    expect(diverging.stateLabelKey).toBe('activity.tstatus_downloading');
  });

  it('shows no percentage for a torrent that does not exist yet', async () => {
    const f = await render([[1, [[8, leaf('searching', 0)], [9, leaf('active', 40)]]]]);
    const [eight, nine] = f.componentInstance.seasonRows()[0].leaves;

    expect(eight.percent).toBeNull();
    expect(nine.percent).toBe(40);
  });
});
