import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { ReleasesModalComponent } from './releases-modal.component';
import { DismissableStackService } from '../../../../core/services/dismissable-stack.service';
import type { MovieRelease } from '../../media-detail-release-picker.service';
import type { IndexerRosterEntry } from '../../release-search-stream.service';

const TRANSLATIONS = {
  media_detail: {
    releases_tab_all: 'All',
    releases_empty: 'No releases found.',
    releases_empty_indexer: 'This indexer returned nothing.',
    indexer_failed: 'No answer in time',
    indexer_cooldown: 'Cooling down',
  },
};

function release(sourceId: number, title: string): MovieRelease {
  return {
    title,
    downloadUrl: `magnet:${title}`,
    qualityId: 3,
    qualityName: '1080p',
    rank: 30,
    allowed: true,
    customFormatScore: 0,
    blocklisted: false,
    sourceId,
    sourceName: `ix-${sourceId}`,
    languageId: 1,
    languageName: 'English',
    languageAllowed: true,
    size: 1_000_000,
    seeders: 5,
    leechers: 1,
    rejections: [],
    freeleech: false,
    downloadVolumeFactor: 1,
    isFullSeason: false,
    sizeDeviation: null,
    videoCodec: null,
  };
}

async function createFixture(inputs: {
  releases?: MovieRelease[];
  indexers?: IndexerRosterEntry[];
  loading?: boolean;
  searched?: boolean;
}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of(TRANSLATIONS) } },
      }),
      { provide: DismissableStackService, useValue: { push: () => undefined, remove: () => undefined } },
    ],
  });
  const fixture = TestBed.createComponent(ReleasesModalComponent);
  fixture.componentRef.setInput('title', 'Releases');
  fixture.componentRef.setInput('releases', inputs.releases ?? []);
  fixture.componentRef.setInput('indexers', inputs.indexers ?? []);
  fixture.componentRef.setInput('loading', inputs.loading ?? false);
  fixture.componentRef.setInput('searched', inputs.searched ?? false);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

const ROSTER: IndexerRosterEntry[] = [
  { id: 1, name: 'alpha', state: 'done' },
  { id: 2, name: 'bravo', state: 'pending' },
  { id: 3, name: 'charlie', state: 'skipped' },
];

describe('ReleasesModalComponent — per-indexer tabs', () => {
  it('shows no tab strip when the search does not stream a roster', async () => {
    const fixture = await createFixture({ releases: [release(1, 'a')] });
    expect(fixture.nativeElement.querySelector('[role="tablist"]')).toBeNull();
  });

  it('puts All first and one tab per rostered indexer, answered or not', async () => {
    const fixture = await createFixture({ releases: [release(1, 'a')], indexers: ROSTER });
    const labels = [...fixture.nativeElement.querySelectorAll('[role="tab"] .tab-label')].map(
      (el: Element) => el.textContent?.trim(),
    );
    expect(labels).toEqual(['All', 'alpha', 'bravo', 'charlie']);
  });

  it('spins only on the indexers still searching', async () => {
    const fixture = await createFixture({ releases: [], indexers: ROSTER });
    const tabs = [...fixture.nativeElement.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabs.map((t) => !!t.querySelector('.loading'))).toEqual([false, false, true, false]);
  });

  it('counts an answered indexer, and leaves a pending one uncounted rather than showing 0', async () => {
    const fixture = await createFixture({
      releases: [release(1, 'a'), release(1, 'b')],
      indexers: ROSTER,
    });
    const badges = [...fixture.nativeElement.querySelectorAll('[role="tab"]')].map(
      (t: Element) => t.querySelector('.badge')?.textContent?.trim() ?? null,
    );
    expect(badges).toEqual(['2', '2', null, '0']);
  });

  it('VERDICT: a per-indexer tab filters the ranked list without reordering it', async () => {
    // Server order interleaves the two indexers; the tab must preserve relative order.
    const rows = [release(1, 'a'), release(2, 'b'), release(1, 'c')];
    const fixture = await createFixture({ releases: rows, indexers: ROSTER });
    const cmp = fixture.componentInstance;

    expect(cmp.visibleReleases()).toEqual(rows);
    cmp.activeTab.set(1);
    expect(cmp.visibleReleases().map((r) => r.title)).toEqual(['a', 'c']);
  });

  it('VERDICT: rows and progress coexist — a filling list is never replaced by the spinner', async () => {
    const fixture = await createFixture({
      releases: [release(1, 'a')],
      indexers: ROSTER,
      loading: true,
    });
    expect(fixture.nativeElement.querySelector('app-releases-table')).not.toBeNull();
    expect(fixture.componentInstance.showSpinnerPanel()).toBe(false);
  });

  it('the full-panel spinner is only for a search with nothing back yet', async () => {
    const fixture = await createFixture({ releases: [], indexers: ROSTER, loading: true });
    expect(fixture.componentInstance.showSpinnerPanel()).toBe(true);
    expect(fixture.nativeElement.querySelector('app-releases-table')).toBeNull();
  });

  it('falls back to All when the open tab is missing from a later roster', async () => {
    const fixture = await createFixture({ releases: [release(1, 'a')], indexers: ROSTER });
    fixture.componentInstance.activeTab.set(3);
    fixture.componentRef.setInput('indexers', [ROSTER[0], ROSTER[1]]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.activeTab()).toBeNull();
  });

  it('an empty indexer tab says so instead of showing the whole-search empty message', async () => {
    const fixture = await createFixture({
      releases: [release(1, 'a')],
      indexers: ROSTER,
      searched: true,
    });
    fixture.componentInstance.activeTab.set(2);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('This indexer returned nothing.');
  });
});
