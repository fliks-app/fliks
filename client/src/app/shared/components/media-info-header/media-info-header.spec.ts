import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import {
  CardActionsService,
  type CardAction,
} from '../../../core/services/card-actions.service';
import { MediaInfoHeaderComponent } from './media-info-header';
import { AuthService } from '../../../core/services/auth.service';
import { OfflinePlaybackSyncService } from '../../../core/services/offline-playback-sync.service';
import { TvService } from '../../../core/services/tv.service';
import { DeviceService } from '../../../core/services/device.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { PlayerSettingsService } from '../../../core/services/player-settings.service';
import { TrackManagerService } from '../../../core/services/track-manager.service';
import { PlayableMediaService } from '../../../core/services/playable-media.service';
import { StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { PluginUiRegistryService } from '../../../core/plugin-ui/plugin-ui-registry.service';
import type { SlotId, UiContribution } from '@fliks/plugin-contract/ui';

/**
 * Permission-matrix + characterisation test for the `media.actions` kebab
 * menu. `when` is presentation only: every action behind these items stays
 * CASL-guarded server-side, so a bypassed predicate here is a cosmetic bug,
 * never an authorization one — but a WRONG one still offers a destructive
 * action to the wrong viewer's eyes, which is what this file exists to catch.
 */

// ── Role model: mirrors backend/src/common/constants/permissions.ts ──

interface Role {
  isAdmin: boolean;
  permissions: string[];
}

function hasPerm(role: Role, perm: string): boolean {
  return role.isAdmin || role.permissions.includes(perm);
}

const OWNER: Role = { isAdmin: true, permissions: [] };
const READER: Role = { isAdmin: false, permissions: ['media.read'] };
const REQUESTER: Role = { isAdmin: false, permissions: ['media.read', 'requests.create'] };
const DELETER: Role = { isAdmin: false, permissions: ['media.delete'] };

/** Reproduces media-detail.ts's own derivations (media-detail.ts:648-668) so the
 *  fixture feeds the header exactly what the real smart component would. */
function deriveInputs(role: Role, opts: { deleteRequestPending?: boolean } = {}) {
  const pending = opts.deleteRequestPending ?? false;
  return {
    canEditProfiles: hasPerm(role, 'media.edit'),
    canDelete: hasPerm(role, 'media.delete'),
    isAdmin: hasPerm(role, 'settings.access'),
    canRequest: hasPerm(role, 'requests.create') && !hasPerm(role, 'media.create'),
    canRequestDeletion: hasPerm(role, 'requests.create') && !hasPerm(role, 'media.delete') && !pending,
  };
}

// ── Fixture / rendering plumbing ──

interface MediaFixture {
  mediaType: 'movie' | 'series';
  episodeId?: number;
  selectedFileId: number | null;
  monitored: boolean;
  qualityProfileName: string | null;
  userHasOpenWholeRequest?: boolean;
  sharingDisabled?: boolean;
  isTv?: boolean;
  watched?: boolean;
  grabBusy?: string | null;
  releasesLoading?: boolean;
  monitoredLoading?: boolean;
  deleteLoading?: boolean;
  registry?: Partial<Record<SlotId, UiContribution[]>>;
  /** Mirrors the episode-level header instance in media-detail.html, which never
   *  binds `canEditProfiles`/`canRequestDeletion` at all (left at their `false`
   *  default) — profile/library editing and deletion requests don't exist at
   *  per-episode granularity. When true, those two inputs are left unset here too. */
  episodeInstance?: boolean;
  /** Playback-state rows keyed by episodeId (0 = media-level), served to the
   *  header's `getPlaybackState` stub. Absent key → no row, like the API. */
  playbackStates?: Record<number, { positionSeconds: number; durationSeconds: number; completed: boolean; mediaFileId: number } | undefined>;
}

async function createFixture(
  role: Role,
  media: MediaFixture,
  opts: { deleteRequestPending?: boolean } = {},
): Promise<ComponentFixture<MediaInfoHeaderComponent>> {
  const derived = deriveInputs(role, opts);
  const watched = media.watched ?? false;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: AuthService,
        useValue: {
          hasPermission: (p: string) => hasPerm(role, p),
          sharingDisabled: () => !!media.sharingDisabled,
        },
      },
      { provide: TvService, useValue: { isTv: () => !!media.isTv } },
      {
        provide: DeviceService,
        useValue: {
          isDesktop: () => true,
          isTablet: () => false,
          isPhone: () => false,
          isTv: () => !!media.isTv,
          isTouch: () => false,
        },
      },
      {
        provide: NavbarService,
        useValue: {
          canGoBack: () => false,
          navbarTransparent: () => false,
          heroLogoUrl: () => null,
          heroTitle: () => '',
          isHeroPage: () => false,
          showBackButton: () => false,
          mobileNavTitle: () => '',
          mobileNavbarVisible: () => true,
          effectiveSidebarPinned: () => false,
          sidebarPinned: () => false,
          toggleSidebarPinned: () => {},
          scrollAtTop: { set: () => {} },
          setPageTitle: () => {},
          resetNavHistory: () => {},
          goBack: () => {},
          lastWasBack: () => false,
        },
      },
      {
        provide: PlayerSettingsService,
        useValue: { resolveAudioStreamIndex: () => null, getRememberedSubtitleTrack: () => null },
      },
      { provide: OfflinePlaybackSyncService, useValue: { queuedPositionFor: () => null } },
      { provide: TrackManagerService, useValue: { saveAudioSelection: () => {}, saveSubtitleSelection: () => {} } },
      { provide: PlayableMediaService, useValue: { loadWatchedState: () => Promise.resolve(watched) } },
      {
        provide: StreamingApiService,
        useValue: {
          getPlaybackState: (_mediaId: number, episodeId?: number) =>
            Promise.resolve(media.playbackStates?.[episodeId ?? 0] ?? null),
        },
      },
      {
        provide: PluginUiRegistryService,
        useValue: { contributionsFor: (slot: SlotId) => media.registry?.[slot] ?? [] },
      },
    ],
  });

  const fixture = TestBed.createComponent(MediaInfoHeaderComponent);
  fixture.componentRef.setInput('title', 'Test title');
  fixture.componentRef.setInput('mediaId', 1);
  fixture.componentRef.setInput('mediaType', media.mediaType);
  fixture.componentRef.setInput('episodeId', media.episodeId);
  fixture.componentRef.setInput('selectedFileId', media.selectedFileId);
  fixture.componentRef.setInput('monitored', media.monitored);
  fixture.componentRef.setInput('qualityProfileName', media.qualityProfileName);
  // Series-root watched state comes from `seriesFullyWatched`, not the playback-state
  // fetch — the component reads it directly when there's no episode context.
  fixture.componentRef.setInput('seriesFullyWatched', watched);
  fixture.componentRef.setInput('canDelete', derived.canDelete);
  fixture.componentRef.setInput('isAdmin', derived.isAdmin);
  fixture.componentRef.setInput('canRequest', derived.canRequest);
  if (!media.episodeInstance) {
    fixture.componentRef.setInput('canEditProfiles', derived.canEditProfiles);
    fixture.componentRef.setInput('canRequestDeletion', derived.canRequestDeletion);
  }
  fixture.componentRef.setInput('userHasOpenWholeRequest', !!media.userHasOpenWholeRequest);
  fixture.componentRef.setInput('grabBusy', media.grabBusy ?? null);
  fixture.componentRef.setInput('releasesLoading', !!media.releasesLoading);
  fixture.componentRef.setInput('monitoredLoading', !!media.monitoredLoading);
  fixture.componentRef.setInput('deleteLoading', !!media.deleteLoading);

  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

interface CapturedItem {
  label: string;
  icon: string | null;
  danger: boolean;
  disabled: boolean;
}

function readItem(el: Element): CapturedItem {
  const svg = el.querySelector('svg');
  const icon = svg
    ? (Array.from(svg.attributes).map((a) => a.name).find((n) => n.startsWith('lucide')) ?? null)
    : null;
  const labelHost = el.querySelector(':scope > span:not(.badge)') ?? el;
  return {
    label: (labelHost.textContent ?? '').trim(),
    icon,
    danger: el.classList.contains('text-error'),
    disabled: (el as HTMLButtonElement).disabled === true,
  };
}

/**
 * The rows the header hands to the shared card actions panel. The header no
 * longer renders the menu itself — it registers the actions and the globally
 * mounted panel draws them — so the assertions read the registry, which is the
 * header's actual output.
 */
function menuActions(fixture: ComponentFixture<MediaInfoHeaderComponent>): CardAction[] {
  fixture.componentInstance.openActionsMenu(document.createElement('button'));
  return TestBed.inject(CardActionsService).actions() ?? [];
}

/** Submenu rows flattened away: these assertions are about which actions a role
 *  can reach and under what gate, not about how they are grouped. The grouping
 *  has its own test. */
function flatActions(fixture: ComponentFixture<MediaInfoHeaderComponent>): CardAction[] {
  return menuActions(fixture).flatMap((a) => a.children ?? [a]);
}

function menuItems(fixture: ComponentFixture<MediaInfoHeaderComponent>): CapturedItem[] {
  return flatActions(fixture).map((a) => ({
    label: a.labelKey ?? a.label ?? '',
    icon: a.icon ?? null,
    danger: a.tone === 'danger',
    disabled: a.disabled === true,
  }));
}

function labels(fixture: ComponentFixture<MediaInfoHeaderComponent>): string[] {
  return menuItems(fixture).map((i) => i.label);
}

// ── The permission matrix ──
//
// Every row lists the FULL expected item set for that role — not just
// whether the destructive ones are absent. Baseline computed by hand from
// the pre-refactor `media-info-header.html` (lines 504-599), independently
// of whatever the registry refactor produces, so it doubles as the
// pre-refactor-vs-post-refactor regression check the brief asks for.

const MOVIE: Omit<MediaFixture, 'mediaType'> = {
  selectedFileId: null,
  monitored: true,
  qualityProfileName: 'HD-1080p',
};
const SERIES: Omit<MediaFixture, 'mediaType'> = {
  selectedFileId: null,
  monitored: true,
  qualityProfileName: 'HD-1080p',
};

describe('MediaInfoHeaderComponent — media.actions permission matrix', () => {
  it('owner (isAdmin): movie root', async () => {
    const fixture = await createFixture(OWNER, { mediaType: 'movie', ...MOVIE });
    expect(labels(fixture)).toEqual([
      'recommend.menu_item',
      'media_detail.like',
      'downloads.download',
      'media_detail.add_to_list',
      'media_card.mark_watched',
      'media_detail.edit_subtitles',
      'media_detail.identify',
      'media_detail.refresh_metadata',
      'tracking.menu_item',
      'media_detail.analyze',
      'media_detail.edit_profiles',
      'media_detail.edit_library',
      'media_detail.unmonitor',
      'media_detail.delete_from_library',
    ]);
  });

  it('owner (isAdmin): series root', async () => {
    const fixture = await createFixture(OWNER, { mediaType: 'series', ...SERIES });
    expect(labels(fixture)).toEqual([
      'recommend.menu_item',
      'media_detail.like',
      'media_detail.add_to_list',
      'media_detail.mark_series_watched',
      'media_detail.identify',
      'media_detail.refresh_metadata',
      'tracking.menu_item',
      'media_detail.analyze',
      'media_detail.edit_profiles',
      'media_detail.edit_library',
      'media_detail.unmonitor',
      'media_detail.delete_from_library',
    ]);
  });

  it('media.read only: movie root', async () => {
    const fixture = await createFixture(READER, { mediaType: 'movie', ...MOVIE });
    expect(labels(fixture)).toEqual([
      'recommend.menu_item',
      'media_detail.like',
      'downloads.download',
      'media_detail.add_to_list',
      'media_card.mark_watched',
      'media_detail.edit_subtitles',
      'tracking.menu_item',
    ]);
  });

  it('media.read only: series root', async () => {
    const fixture = await createFixture(READER, { mediaType: 'series', ...SERIES });
    expect(labels(fixture)).toEqual([
      'recommend.menu_item',
      'media_detail.like',
      'media_detail.add_to_list',
      'media_detail.mark_series_watched',
      'tracking.menu_item',
    ]);
  });

  it('media.read + requests.create: movie root', async () => {
    const fixture = await createFixture(REQUESTER, { mediaType: 'movie', ...MOVIE });
    expect(labels(fixture)).toEqual([
      'recommend.menu_item',
      'media_detail.like',
      'downloads.download',
      'media_detail.add_to_list',
      'media_card.mark_watched',
      'media_detail.request_media',
      'media_detail.edit_subtitles',
      'tracking.menu_item',
      'media_detail.request_deletion',
    ]);
  });

  it('media.read + requests.create: series root', async () => {
    const fixture = await createFixture(REQUESTER, { mediaType: 'series', ...SERIES });
    expect(labels(fixture)).toEqual([
      'recommend.menu_item',
      'media_detail.like',
      'media_detail.add_to_list',
      'media_detail.mark_series_watched',
      'media_detail.request_media',
      'tracking.menu_item',
      'media_detail.request_deletion',
    ]);
  });

  it('media.delete: movie root', async () => {
    const fixture = await createFixture(DELETER, { mediaType: 'movie', ...MOVIE });
    expect(labels(fixture)).toEqual([
      'recommend.menu_item',
      'media_detail.like',
      'downloads.download',
      'media_detail.add_to_list',
      'media_card.mark_watched',
      'media_detail.edit_subtitles',
      'tracking.menu_item',
      'media_detail.delete_from_library',
    ]);
  });

  it('media.delete: series root', async () => {
    const fixture = await createFixture(DELETER, { mediaType: 'series', ...SERIES });
    expect(labels(fixture)).toEqual([
      'recommend.menu_item',
      'media_detail.like',
      'media_detail.add_to_list',
      'media_detail.mark_series_watched',
      'tracking.menu_item',
      'media_detail.delete_from_library',
    ]);
  });
});

// ── Destructive items keep their styling, and stay gone once request state changes ──

describe('MediaInfoHeaderComponent — destructive-item styling and ephemeral guards', () => {
  it('Delete and Request deletion render with danger styling; nothing else does', async () => {
    const fixture = await createFixture(OWNER, { mediaType: 'movie', ...MOVIE });
    const items = menuItems(fixture);
    const dangerLabels = items.filter((i) => i.danger).map((i) => i.label);
    expect(dangerLabels).toEqual(['media_detail.delete_from_library']);

    const requester = await createFixture(REQUESTER, { mediaType: 'movie', ...MOVIE });
    const requesterDanger = menuItems(requester).filter((i) => i.danger).map((i) => i.label);
    expect(requesterDanger).toEqual(['media_detail.request_deletion']);
  });

  it('a pending deletion request hides Request deletion even though the permission still holds', async () => {
    const fixture = await createFixture(
      REQUESTER,
      { mediaType: 'movie', ...MOVIE },
      { deleteRequestPending: true },
    );
    expect(labels(fixture)).not.toContain('media_detail.request_deletion');
  });

  it('an existing whole-title request hides Request media even though the permission still holds', async () => {
    const fixture = await createFixture(REQUESTER, {
      mediaType: 'movie',
      ...MOVIE,
      userHasOpenWholeRequest: true,
    });
    expect(labels(fixture)).not.toContain('media_detail.request_media');
  });

  it('a movie that already has a file hides Request media (nothing left to request)', async () => {
    const fixture = await createFixture(REQUESTER, { mediaType: 'movie', ...MOVIE, selectedFileId: 42 });
    expect(labels(fixture)).not.toContain('media_detail.request_media');
  });

  it('a series root still offers Request media even with files present — partial availability is requestable', async () => {
    const fixture = await createFixture(REQUESTER, { mediaType: 'series', ...SERIES, selectedFileId: 42 });
    expect(labels(fixture)).toContain('media_detail.request_media');
  });

  it('sharing-disabled hides Recommend for every role, including the owner', async () => {
    const fixture = await createFixture(OWNER, { mediaType: 'movie', ...MOVIE, sharingDisabled: true });
    expect(labels(fixture)).not.toContain('recommend.menu_item');
  });

  it('TV form factor hides Recommend for every role, including the owner', async () => {
    const fixture = await createFixture(OWNER, { mediaType: 'movie', ...MOVIE, isTv: true });
    expect(labels(fixture)).not.toContain('recommend.menu_item');
  });

  it('an episode-level header hides Edit profiles/library and Request deletion for an owner — the parent never binds those inputs there, regardless of permission', async () => {
    const fixture = await createFixture(OWNER, {
      mediaType: 'movie',
      ...MOVIE,
      episodeId: 999,
      episodeInstance: true,
    });
    const shown = labels(fixture);
    expect(shown).not.toContain('media_detail.edit_profiles');
    expect(shown).not.toContain('media_detail.edit_library');
    expect(shown).not.toContain('media_detail.request_deletion');
    // isAdmin-gated items ARE bound per-episode and must still show.
    expect(shown).toContain('media_detail.refresh_metadata');
    expect(shown).toContain('media_detail.analyze');
    expect(shown).toContain('media_detail.delete_from_library');
  });

  it('the series-watched toggle swaps its label with the live watched state', async () => {
    const unwatched = await createFixture(OWNER, { mediaType: 'series', ...SERIES, watched: false });
    expect(labels(unwatched)).toContain('media_detail.mark_series_watched');

    const watched = await createFixture(OWNER, { mediaType: 'series', ...SERIES, watched: true });
    expect(labels(watched)).toContain('media_detail.mark_series_unwatched');
  });
});

// ── New in this PR: merging with plugin contributions. Meaningless before the
// registry existed, so these are additions, not part of the characterisation set above.

describe('MediaInfoHeaderComponent — media.actions merges with plugin contributions', () => {
  it('sorts a plugin item into position by weight, between two core items', async () => {
    const fixture = await createFixture(OWNER, {
      mediaType: 'movie',
      ...MOVIE,
      registry: {
        'media.actions': [
          {
            id: 'fliks.acme.between',
            slot: 'media.actions',
            weight: 150,
            labelKey: 'x.between',
            action: { kind: 'route', path: '/plugins/acme/between' },
          },
        ],
      },
    });
    const shown = labels(fixture);
    expect(shown.indexOf('recommend.menu_item')).toBe(0);
    // Relative: an index breaks whenever a row joins the list.
    expect(shown.indexOf('x.between')).toBeGreaterThan(shown.indexOf('recommend.menu_item'));
    expect(shown.indexOf('x.between')).toBeLessThan(shown.indexOf('tracking.menu_item'));
    expect(shown.indexOf('tracking.menu_item')).toBeGreaterThan(1);
  });

  it('passes an unrecognised icon name through — the panel owns the fallback glyph', async () => {
    const fixture = await createFixture(OWNER, {
      mediaType: 'movie',
      ...MOVIE,
      registry: {
        'media.actions': [
          {
            id: 'fliks.acme.weird-icon',
            slot: 'media.actions',
            weight: 150,
            labelKey: 'x.weird',
            icon: 'not-a-real-lucide-name',
            action: { kind: 'route', path: '/plugins/acme/weird' },
          },
        ],
      },
    });
    const item = menuItems(fixture).find((i) => i.label === 'x.weird');
    expect(item?.icon).toBe('not-a-real-lucide-name');
  });

  it('VERDICT: an unknown actionId renders no row — fail closed, not a dead click', async () => {
    const fixture = await createFixture(OWNER, {
      mediaType: 'movie',
      ...MOVIE,
      registry: {
        'media.actions': [
          {
            id: 'fliks.acme.bogus-action',
            slot: 'media.actions',
            weight: 150,
            labelKey: 'x.bogus',
            action: { kind: 'action', actionId: 'media.something-invented' },
          },
        ],
      },
    });
    expect(labels(fixture)).not.toContain('x.bogus');
  });

  it('VERDICT: an unrecognised action.kind renders no row', async () => {
    const fixture = await createFixture(OWNER, {
      mediaType: 'movie',
      ...MOVIE,
      registry: {
        'media.actions': [
          { id: 'fliks.acme.broken', slot: 'media.actions', weight: 150, labelKey: 'x.broken', action: { kind: 'bogus' } as never },
        ],
      },
    });
    expect(labels(fixture)).not.toContain('x.broken');
  });

  it('a plugin can reuse a core actionId (its handler), but must bring its own `when` — core\'s `when` is per-contribution, not per-actionId', async () => {
    const gatedRegistry = {
      'media.actions': [
        {
          id: 'fliks.acme.delete-alias',
          slot: 'media.actions' as const,
          weight: 150,
          labelKey: 'x.delete_alias',
          when: ['hasPermission:media.delete' as const],
          action: { kind: 'action' as const, actionId: 'media.delete' },
        },
      ],
    };
    const reader = await createFixture(READER, { mediaType: 'movie', ...MOVIE, registry: gatedRegistry });
    expect(labels(reader)).not.toContain('x.delete_alias');

    const deleter = await createFixture(DELETER, { mediaType: 'movie', ...MOVIE, registry: gatedRegistry });
    expect(labels(deleter)).toContain('x.delete_alias');
  });

  it('a plugin cannot widen a core action: an alias with no `when` stays hidden from a role core hides it from', async () => {
    // The alias reuses core's Delete handler, so it must clear core's own gate too —
    // otherwise a plugin could surface core's destructive action to anyone.
    const wideOpen = {
      'media.actions': [
        {
          id: 'fliks.acme.delete-wide',
          slot: 'media.actions' as const,
          weight: 150,
          labelKey: 'x.delete_wide',
          action: { kind: 'action' as const, actionId: 'media.delete' },
        },
      ],
    };
    const reader = await createFixture(READER, { mediaType: 'movie', ...MOVIE, registry: wideOpen });
    expect(labels(reader)).not.toContain('x.delete_wide');

    const deleter = await createFixture(DELETER, { mediaType: 'movie', ...MOVIE, registry: wideOpen });
    expect(labels(deleter)).toContain('x.delete_wide');
  });
});

// ── The release picker (`media.grab-best` / `media.search-releases`): core owns the
// handler and the modals it opens, but the menu entry itself is a plugin contribution —
// with no plugin installed, no button exists at all.

describe('MediaInfoHeaderComponent — release-picker actions are plugin-contributed, not core items', () => {
  const releasePickerRegistry = {
    'media.actions': [
      {
        id: 'fliks.acme.grab-best',
        slot: 'media.actions' as const,
        weight: 500,
        labelKey: 'x.grab_best',
        icon: 'download',
        action: { kind: 'action' as const, actionId: 'media.grab-best' },
      },
      {
        id: 'fliks.acme.search-releases',
        slot: 'media.actions' as const,
        weight: 600,
        labelKey: 'x.search_releases',
        icon: 'search',
        action: { kind: 'action' as const, actionId: 'media.search-releases' },
      },
    ],
  };

  it('VERDICT: with no plugin installed, neither entry exists — core carries no acquisition menu item', async () => {
    const fixture = await createFixture(OWNER, { mediaType: 'movie', ...MOVIE });
    const shown = labels(fixture);
    expect(shown).not.toContain('x.grab_best');
    expect(shown).not.toContain('x.search_releases');
  });

  it('a plugin contribution surfaces both actions and routes clicks to core\'s own outputs', async () => {
    const fixture = await createFixture(OWNER, { mediaType: 'movie', ...MOVIE, registry: releasePickerRegistry });
    const shown = labels(fixture);
    const grabIdx = shown.indexOf('x.grab_best');
    const searchIdx = shown.indexOf('x.search_releases');
    expect(grabIdx).toBeGreaterThanOrEqual(0);
    expect(searchIdx).toBeGreaterThanOrEqual(0);

    let grabbed = false;
    let searched = false;
    fixture.componentInstance.grabBest.subscribe(() => (grabbed = true));
    fixture.componentInstance.loadReleases.subscribe(() => (searched = true));

    const rows = flatActions(fixture);
    rows[grabIdx].run();
    rows[searchIdx].run();

    expect(grabbed).toBe(true);
    expect(searched).toBe(true);
  });

  it('grabBusy/releasesLoading still drive the busy spinner + disabled state for the plugin-contributed rows', async () => {
    // Busy swaps the icon slot for a spinner, which shifts readItem's label lookup —
    // so locate the row by index (idle fixture) rather than by its now-blank label.
    const idle = await createFixture(OWNER, { mediaType: 'movie', ...MOVIE, registry: releasePickerRegistry });
    const grabIdx = labels(idle).indexOf('x.grab_best');
    expect(grabIdx).toBeGreaterThanOrEqual(0);
    expect(flatActions(idle)[grabIdx].disabled).toBe(false);

    const busy = await createFixture(OWNER, {
      mediaType: 'movie',
      ...MOVIE,
      registry: releasePickerRegistry,
      grabBusy: 'best',
      releasesLoading: true,
    });
    expect(flatActions(busy)[grabIdx].disabled).toBe(true);
  });
});

describe('MediaInfoHeaderComponent — resume state across an episode switch', () => {
  const SERIES_EPISODE: MediaFixture = {
    mediaType: 'series',
    episodeId: 3,
    selectedFileId: null,
    monitored: true,
    qualityProfileName: 'HD-1080p',
    episodeInstance: true,
    // Only episode 3 was ever played: 33:12 of a 61-minute episode.
    playbackStates: {
      3: { positionSeconds: 1992, durationSeconds: 3660, completed: false, mediaFileId: 30 },
    },
  };

  it('drops the previous episode progress when the header switches episode', async () => {
    const fixture = await createFixture(OWNER, SERIES_EPISODE);
    expect(fixture.componentInstance.resumePositionSeconds()).toBe(1992);

    fixture.componentRef.setInput('episodeId', 4);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Episode 4 has no playback row — nothing to resume, no progress bar.
    expect(fixture.componentInstance.resumePositionSeconds()).toBeNull();
    expect(fixture.componentInstance.durationSeconds()).toBeNull();
  });
});
