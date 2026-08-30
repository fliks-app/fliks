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
    releases_empty_indexer: 'No results for this indexer.',
    indexer_failed: 'This indexer did not answer.',
    indexer_cooldown: 'Skipped — cooling down after an error.',
    releases_searching: 'Searching…',
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

  it('VERDICT: All spins while the search runs — progress lives in the strip, not the modal title', async () => {
    const fixture = await createFixture({
      releases: [release(1, 'a')],
      indexers: ROSTER,
      loading: true,
    });
    const tabs = [...fixture.nativeElement.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(!!tabs[0].querySelector('.loading')).toBe(true);
    expect(fixture.nativeElement.querySelector('h3 .loading')).toBeNull();
  });

  it('a spinner gives way to the count badge in the same slot, so the strip does not shift', async () => {
    const fixture = await createFixture({ releases: [release(1, 'a')], indexers: ROSTER, loading: true });
    const slotOf = (i: number) =>
      [...fixture.nativeElement.querySelectorAll('[role="tab"] .tab-count')][i] as HTMLElement;

    expect(slotOf(0).querySelector('.loading')).not.toBeNull();
    expect(slotOf(0).querySelector('.badge')).toBeNull();

    fixture.componentRef.setInput('loading', false);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(slotOf(0).querySelector('.loading')).toBeNull();
    expect(slotOf(0).querySelector('.badge')?.textContent?.trim()).toBe('1');
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

  it('VERDICT: a tab whose indexer is still running says so instead of claiming no results', async () => {
    // bravo is `pending`: it has nothing yet, which is not the same as having nothing.
    const fixture = await createFixture({ releases: [release(1, 'a')], indexers: ROSTER, loading: true });
    fixture.componentInstance.activeTab.set(2);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('Searching…');
    expect(fixture.nativeElement.textContent).not.toContain('No results for this indexer.');
  });

  it('a skipped indexer says it is cooling down, not that it found nothing', async () => {
    // charlie is `skipped`: it never ran, so "no results" would be a lie — and the search
    // still being in flight must not turn its tab into a spinner that never resolves.
    const fixture = await createFixture({ releases: [release(1, 'a')], indexers: ROSTER, loading: true });
    fixture.componentInstance.activeTab.set(3);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('cooling down');
    expect(fixture.nativeElement.textContent).not.toContain('Searching…');
    expect(fixture.nativeElement.querySelector('svg[lucideCirclePause]')).not.toBeNull();
  });

  it('VERDICT: a failed indexer is not reported as an empty one — the fixes differ', async () => {
    const roster: IndexerRosterEntry[] = [
      { id: 1, name: 'alpha', state: 'done' },
      { id: 2, name: 'bravo', state: 'failed' },
    ];
    const fixture = await createFixture({ releases: [release(1, 'a')], indexers: roster, searched: true });
    fixture.componentInstance.activeTab.set(2);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('This indexer did not answer.');
    expect(fixture.nativeElement.textContent).not.toContain('No results for this indexer.');
    expect(fixture.nativeElement.querySelector('svg[lucideTriangleAlert]')).not.toBeNull();
  });

  it('an answered indexer with no hits still reports no results', async () => {
    const roster: IndexerRosterEntry[] = [
      { id: 1, name: 'alpha', state: 'done' },
      { id: 2, name: 'bravo', state: 'done' },
    ];
    const fixture = await createFixture({ releases: [release(1, 'a')], indexers: roster, searched: true });
    fixture.componentInstance.activeTab.set(2);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('No results for this indexer.');
    expect(fixture.nativeElement.querySelector('svg[lucideSearchX]')).not.toBeNull();
  });

  it('rows beat the spinner on a tab whose indexer is still running', async () => {
    const roster: IndexerRosterEntry[] = [{ id: 1, name: 'alpha', state: 'pending' }];
    const fixture = await createFixture({ releases: [release(1, 'a')], indexers: roster, loading: true });
    fixture.componentInstance.activeTab.set(1);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('app-releases-table')).not.toBeNull();
    expect(fixture.componentInstance.showSpinnerPanel()).toBe(false);
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
    expect(fixture.nativeElement.textContent).toContain('No results for this indexer.');
    // Both empty states share one centred block, icon included — an indexer tab that fell back
    // to a bare paragraph would read as a different screen.
    expect(fixture.nativeElement.querySelector('svg[lucideSearchX]')).not.toBeNull();
  });

  it('the whole-search empty message uses the same centred block', async () => {
    const fixture = await createFixture({ releases: [], indexers: ROSTER, searched: true });
    expect(fixture.componentInstance.emptyPanel().key).toBe('media_detail.releases_empty');
    expect(fixture.nativeElement.textContent).toContain('No releases found.');
    expect(fixture.nativeElement.querySelector('svg[lucideSearchX]')).not.toBeNull();
  });
});

describe('ReleasesModalComponent — only what the profile allows', () => {
  const outside = (sourceId: number, title: string, code: string): MovieRelease => ({
    ...release(sourceId, title),
    allowed: false,
    rejections: [{ code }],
  });

  it('VERDICT: a quality above the profile is never listed', async () => {
    const fixture = await createFixture({
      releases: [release(1, 'in-profile'), outside(1, 'remux-2160p', 'QUALITY_NOT_ALLOWED')],
    });
    expect(fixture.componentInstance.visibleReleases().map((r) => r.title)).toEqual(['in-profile']);
  });

  it('VERDICT: a quality below it is not a fallback either — membership, not a ceiling', async () => {
    const fixture = await createFixture({
      releases: [release(1, 'in-profile'), outside(1, 'sd-720p', 'QUALITY_NOT_ALLOWED')],
    });
    expect(fixture.componentInstance.visibleReleases().map((r) => r.title)).toEqual(['in-profile']);
  });

  it('the tab counts drop them too — a count that promises a hidden row is a bug', async () => {
    const fixture = await createFixture({
      releases: [
        release(1, 'in-profile'),
        outside(1, 'remux', 'QUALITY_NOT_ALLOWED'),
        outside(2, 'sd', 'QUALITY_NOT_ALLOWED'),
      ],
      indexers: ROSTER,
    });
    expect(fixture.componentInstance.tabs().map((t) => t.count)).toEqual([1, 1, null, 0]);
  });

  it('a release the profile allows but something else rejects still shows, to be forced by hand', async () => {
    const seedless: MovieRelease = {
      ...release(1, 'few-seeders'),
      allowed: true,
      rejections: [{ code: 'MIN_SEEDERS', params: { actual: 0, min: 5 } }],
    };
    const fixture = await createFixture({ releases: [seedless] });
    expect(fixture.componentInstance.visibleReleases().map((r) => r.title)).toEqual(['few-seeders']);
  });
});
