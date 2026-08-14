import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { MediaDetailSeasonsComponent } from './media-detail-seasons.component';
import { Media, Season } from '../../../../core/services/api/media.service';
import { PlayableMediaService } from '../../../../core/services/playable-media.service';
import { AddToPlaylistService } from '../../../../core/services/add-to-playlist.service';
import { TvService } from '../../../../core/services/tv.service';
import { AuthService } from '../../../../core/services/auth.service';
import { DeviceService } from '../../../../core/services/device.service';
import { PluginUiRegistryService } from '../../../../core/plugin-ui/plugin-ui-registry.service';
import type { SlotId, UiContribution } from '@fliks/plugin-contract/ui';

/**
 * `media.season.actions` is a plugin-only slot — core contributes nothing to it,
 * so the two release-picker rows in the season dropdown (search/grab) exist only
 * once a plugin declares them. This mirrors the `media.actions` characterisation
 * style in media-info-header.spec.ts, scoped to the season actions dropdown.
 */

const SEASON: Season = {
  id: 11,
  seasonNumber: 1,
  monitored: false,
  posterUrl: null,
  episodes: [],
};

function makeMedia(overrides: Partial<Media> = {}): Media {
  return {
    id: 5,
    title: 'Title',
    originalTitle: 'Title',
    year: 2020,
    type: 'series',
    tmdbId: 1,
    overview: '',
    status: 'released',
    monitored: true,
    posterUrl: null,
    fanartUrl: null,
    logoUrl: null,
    additionalFanartUrls: [],
    rating: 0,
    runtime: 30,
    files: [],
    seasons: [SEASON],
    qualityProfile: { id: 1, name: 'HD-1080p', cutoff: 1, upgradeAllowed: true, items: [] },
    ...overrides,
  } as Media;
}

interface FixtureOpts {
  registry?: Partial<Record<SlotId, UiContribution[]>>;
  seasonReleasesLoading?: boolean;
  seasonReleasesOpenId?: number | null;
  seasonGrabBusy?: string | null;
  media?: Media;
}

async function createFixture(opts: FixtureOpts = {}): Promise<ComponentFixture<MediaDetailSeasonsComponent>> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: TvService, useValue: { isTv: () => false } },
      { provide: AuthService, useValue: { hasPermission: () => false, sharingDisabled: () => false } },
      { provide: DeviceService, useValue: { input: () => 'mouse', isTouch: () => false } },
      { provide: PlayableMediaService, useValue: { play: () => Promise.resolve() } },
      { provide: AddToPlaylistService, useValue: { open: () => {} } },
      {
        provide: PluginUiRegistryService,
        useValue: { contributionsFor: (slot: SlotId) => opts.registry?.[slot] ?? [] },
      },
    ],
  });

  const fixture = TestBed.createComponent(MediaDetailSeasonsComponent);
  fixture.componentRef.setInput('media', opts.media ?? makeMedia());
  fixture.componentRef.setInput('selectedSeason', SEASON);
  fixture.componentRef.setInput('activeSeasonId', SEASON.id);
  fixture.componentRef.setInput('filteredEpisodes', []);
  fixture.componentRef.setInput('seasonReleasesLoading', opts.seasonReleasesLoading ?? false);
  fixture.componentRef.setInput('seasonReleasesOpenId', opts.seasonReleasesOpenId ?? null);
  fixture.componentRef.setInput('seasonGrabBusy', opts.seasonGrabBusy ?? null);

  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

/** The season-actions dropdown is the first `app-dropdown-menu` in the template —
 *  the second one is the season-tab selector, whose options render with the same
 *  `.dropdown-item` class and would otherwise pollute a page-wide query. */
function seasonDropdownItems(root: HTMLElement): HTMLButtonElement[] {
  const menu = root.querySelectorAll('app-dropdown-menu')[0];
  if (!menu) return [];
  return Array.from(menu.querySelectorAll('.dropdown-item')) as HTMLButtonElement[];
}

function seasonDropdownLabels(root: HTMLElement): string[] {
  return seasonDropdownItems(root).map(
    (el) => (el.querySelector(':scope > span:not(.badge)') ?? el).textContent?.trim() ?? '',
  );
}

const SEASON_ACTIONS_REGISTRY: Partial<Record<SlotId, UiContribution[]>> = {
  'media.season.actions': [
    {
      id: 'fliks.acme.season-search',
      slot: 'media.season.actions',
      weight: 500,
      labelKey: 'x.search_releases',
      icon: 'package',
      action: { kind: 'action', actionId: 'season.search-releases' },
    },
    {
      id: 'fliks.acme.season-grab',
      slot: 'media.season.actions',
      weight: 600,
      labelKey: 'x.grab_best',
      icon: 'download',
      action: { kind: 'action', actionId: 'season.grab-best' },
    },
  ],
};

describe('MediaDetailSeasonsComponent — media.season.actions is plugin-only', () => {
  it('VERDICT: with no plugin installed, no release-picker row renders in the season dropdown', async () => {
    const fixture = await createFixture();
    const labels = seasonDropdownLabels(fixture.nativeElement);
    expect(labels).not.toContain('x.search_releases');
    expect(labels).not.toContain('x.grab_best');
  });

  it('a plugin contribution surfaces both season actions and routes clicks to loadSeasonReleases/grabSeason', async () => {
    const fixture = await createFixture({ registry: SEASON_ACTIONS_REGISTRY });
    const labels = seasonDropdownLabels(fixture.nativeElement);
    const searchIdx = labels.indexOf('x.search_releases');
    const grabIdx = labels.indexOf('x.grab_best');
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(grabIdx).toBeGreaterThanOrEqual(0);

    let loaded: Season | undefined;
    let grabbed: Season | undefined;
    fixture.componentInstance.loadSeasonReleases.subscribe((s) => (loaded = s));
    fixture.componentInstance.grabSeason.subscribe((s) => (grabbed = s));

    const items = seasonDropdownItems(fixture.nativeElement);
    items[searchIdx].click();
    items[grabIdx].click();

    expect(loaded?.id).toBe(SEASON.id);
    expect(grabbed?.id).toBe(SEASON.id);
  });

  it('seasonReleasesLoading/seasonGrabBusy still drive the busy spinner + disabled state for the plugin-contributed rows', async () => {
    // Busy swaps the icon slot for a spinner, which shifts the label lookup — locate
    // rows by index from an idle fixture rather than by their now-blank label.
    const idle = await createFixture({ registry: SEASON_ACTIONS_REGISTRY });
    const idleLabels = seasonDropdownLabels(idle.nativeElement);
    const searchIdx = idleLabels.indexOf('x.search_releases');
    const grabIdx = idleLabels.indexOf('x.grab_best');
    expect(seasonDropdownItems(idle.nativeElement)[searchIdx].disabled).toBe(false);
    expect(seasonDropdownItems(idle.nativeElement)[grabIdx].disabled).toBe(false);

    const busySearch = await createFixture({
      registry: SEASON_ACTIONS_REGISTRY,
      seasonReleasesLoading: true,
      seasonReleasesOpenId: SEASON.id,
    });
    expect(seasonDropdownItems(busySearch.nativeElement)[searchIdx].disabled).toBe(true);
    expect(seasonDropdownItems(busySearch.nativeElement)[grabIdx].disabled).toBe(false);

    const busyGrab = await createFixture({ registry: SEASON_ACTIONS_REGISTRY, seasonGrabBusy: 'best' });
    expect(seasonDropdownItems(busyGrab.nativeElement)[grabIdx].disabled).toBe(true);
    expect(seasonDropdownItems(busyGrab.nativeElement)[searchIdx].disabled).toBe(false);
  });
});
