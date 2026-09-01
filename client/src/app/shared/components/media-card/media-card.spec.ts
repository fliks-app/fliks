import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { MediaCardComponent } from './media-card';
import { Media } from '../../../core/services/api/media.service';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { RecommendService } from '../../../core/services/recommend.service';
import { TvService } from '../../../core/services/tv.service';
import { AuthService } from '../../../core/services/auth.service';
import { DeviceService } from '../../../core/services/device.service';
import { PlayableMediaService } from '../../../core/services/playable-media.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { PluginUiRegistryService } from '../../../core/plugin-ui/plugin-ui-registry.service';
import type { SlotId, UiContribution } from '@fliks/plugin-contract/ui';

/**
 * Characterisation test for the card's contextual actions menu. Captures the
 * action list as data ({labelKey, icon, tone}) plus each handler's real side
 * effect, across every distinct input combination a real caller uses today
 * (grepped from home/library/search/media-detail/media-detail-seasons) — a
 * silent change in what a viewer sees, or in what a row's click actually
 * does, fails here.
 *
 * `PluginUiRegistryService` is provided (empty by default) so this file
 * keeps passing whether or not the component consumes it.
 */

interface Role {
  isTv?: boolean;
  sharingDisabled?: boolean;
  isAdmin?: boolean;
}
const FULL_MEMBER: Role = {};
const TV_VIEWER: Role = { isTv: true };
const SHARING_DISABLED: Role = { sharingDisabled: true };
const ADMIN: Role = { isAdmin: true };

interface Harness {
  fixture: ComponentFixture<MediaCardComponent>;
  router: Router;
  addToPlaylist: { open: ReturnType<typeof vi.fn> };
  recommend: { open: ReturnType<typeof vi.fn> };
  playableMedia: { play: ReturnType<typeof vi.fn> };
}

async function createFixture(
  role: Role,
  inputs: Record<string, unknown>,
  registry: Partial<Record<SlotId, UiContribution[]>> = {},
): Promise<Harness> {
  const addToPlaylist = { open: vi.fn() };
  const recommend = { open: vi.fn() };
  const playableMedia = { play: vi.fn().mockResolvedValue(undefined) };
  const navbar = { markAsBackNavigation: vi.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: TvService, useValue: { isTv: () => !!role.isTv } },
      {
        provide: AuthService,
        useValue: {
          hasPermission: () => !!role.isAdmin,
          sharingDisabled: () => !!role.sharingDisabled,
        },
      },
      { provide: DeviceService, useValue: { input: () => 'mouse', isTouch: () => false } },
      { provide: AddToPlaylistService, useValue: addToPlaylist },
      { provide: RecommendService, useValue: recommend },
      { provide: PlayableMediaService, useValue: playableMedia },
      { provide: NavbarService, useValue: navbar },
      {
        provide: PluginUiRegistryService,
        useValue: { contributionsFor: (slot: SlotId) => registry[slot] ?? [] },
      },
    ],
  });

  const fixture = TestBed.createComponent(MediaCardComponent);
  for (const [key, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(key, value);
  }
  const router = TestBed.inject(Router);

  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  return { fixture, router, addToPlaylist, recommend, playableMedia };
}

function makeMedia(overrides: Partial<Media> = {}): Media {
  return {
    id: 5,
    title: 'Title',
    originalTitle: 'Title',
    year: 2020,
    type: 'movie',
    tmdbId: 1,
    overview: '',
    status: 'released',
    monitored: true,
    posterUrl: null,
    fanartUrl: null,
    logoUrl: null,
    additionalFanartUrls: [],
    rating: 0,
    runtime: 90,
    files: [],
    ...overrides,
  } as Media;
}

interface Shape {
  labelKey: string | undefined;
  icon: string | undefined;
  tone: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function actions(h: Harness): any[] {
  return (h.fixture.componentInstance as any).cardActions();
}
function shapes(h: Harness): Shape[] {
  return actions(h).map((a) => ({ labelKey: a.labelKey, icon: a.icon, tone: a.tone ?? 'default' }));
}
function labels(h: Harness): (string | undefined)[] {
  return shapes(h).map((s) => s.labelKey);
}
function findAction(h: Harness, labelKey: string): any {
  return actions(h).find((a) => a.labelKey === labelKey);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('MediaCardComponent — card.actions characterisation', () => {
  it('continue-watching row (home.html): play-intent + playlist target + dismissable + interactiveWatched', async () => {
    const h = await createFixture(FULL_MEMBER, {
      link: ['/movies', '7'],
      playlistMediaId: 7,
      playlistEpisodeId: 3,
      playable: true,
      dismissable: true,
      interactiveWatched: true,
      clickIntent: 'play',
    });
    expect(shapes(h)).toEqual([
      { labelKey: 'media_card.action_play', icon: 'play', tone: 'default' },
      { labelKey: 'media_card.action_open', icon: 'external-link', tone: 'default' },
      { labelKey: 'recommend.menu_item', icon: 'user-plus', tone: 'default' },
      { labelKey: 'media_detail.add_to_list', icon: 'list-plus', tone: 'default' },
      { labelKey: 'media_card.mark_watched', icon: 'eye', tone: 'default' },
      { labelKey: 'media_card.remove_from_list', icon: 'trash-2', tone: 'danger' },
    ]);
  });

  it('recommendation row (home.html), available: extraActions + dismissable, no interactiveWatched', async () => {
    const h = await createFixture(FULL_MEMBER, {
      link: ['/movies', '9'],
      playlistMediaId: 9,
      status: null,
      playable: true,
      dismissable: true,
      extraActions: [{ labelKey: 'media_card.mark_watched', icon: 'eye', run: () => {} }],
    });
    expect(labels(h)).toEqual([
      'media_card.action_play',
      'media_card.action_open',
      'recommend.menu_item',
      'media_detail.add_to_list',
      'media_card.mark_watched',
      'media_card.remove_from_list',
    ]);
  });

  it('recommendation row, unavailable: Play drops out, the rest holds', async () => {
    const h = await createFixture(FULL_MEMBER, {
      link: ['/movies', '9'],
      playlistMediaId: 9,
      status: 'missing',
      playable: false,
      dismissable: true,
      extraActions: [{ labelKey: 'media_card.mark_watched', icon: 'eye', run: () => {} }],
    });
    expect(labels(h)).toEqual([
      'media_card.action_open',
      'recommend.menu_item',
      'media_detail.add_to_list',
      'media_card.mark_watched',
      'media_card.remove_from_list',
    ]);
  });

  it('library/search grid card with files: [media]-driven, interactiveWatched on, never dismissable', async () => {
    const h = await createFixture(FULL_MEMBER, {
      media: makeMedia({ id: 5, files: [{ id: 1, quality: '1080p', relativePath: 'x', size: 1 }] }),
      status: null,
      interactiveWatched: true,
    });
    expect(labels(h)).toEqual([
      'media_card.action_play',
      'media_card.action_open',
      'recommend.menu_item',
      'media_detail.add_to_list',
      'media_card.mark_watched',
      'media_detail.advanced_group',
    ]);
  });

  it('library/search grid card, missing files, read-only (interactiveWatched off)', async () => {
    const h = await createFixture(FULL_MEMBER, {
      media: makeMedia({ id: 5, files: [] }),
      status: null,
      interactiveWatched: false,
    });
    // A `[media]`-driven card carries the monitored flag and a media type, so the
    // rows gated on those reach it too - the same list as the detail menu, minus
    // what this surface has no handler for.
    expect(labels(h)).toEqual([
      'media_card.action_open',
      'recommend.menu_item',
      'media_detail.add_to_list',
      'media_detail.advanced_group',
    ]);
  });

  it('episode row (media-detail-seasons) with a file: play-intent via clickIntent, playlist target from ids', async () => {
    const h = await createFixture(FULL_MEMBER, {
      link: ['/series', '1', 'episode', '2'],
      playlistMediaId: 1,
      playlistEpisodeId: 2,
      playable: true,
      interactiveWatched: true,
      clickIntent: 'play',
    });
    expect(labels(h)).toEqual([
      'media_card.action_play',
      'media_card.action_open',
      'recommend.menu_item',
      'media_detail.add_to_list',
      'media_card.mark_watched',
    ]);
  });

  it('episode row, no file: Play and the watched toggle drop out; the playlist target survives on ids alone', async () => {
    const h = await createFixture(FULL_MEMBER, {
      link: ['/series', '1', 'episode', '2'],
      playlistMediaId: 1,
      playlistEpisodeId: 2,
      playable: false,
      interactiveWatched: false,
      clickIntent: 'open',
    });
    expect(labels(h)).toEqual(['media_card.action_open', 'recommend.menu_item', 'media_detail.add_to_list']);
  });

  it('season card (media-detail): interactiveWatched only, no playlist target — Add/Recommend absent without an id', async () => {
    const h = await createFixture(FULL_MEMBER, {
      link: ['/series', '1', 'season', '2'],
      interactiveWatched: true,
      status: null,
    });
    expect(shapes(h)).toEqual([
      { labelKey: 'media_card.action_open', icon: 'external-link', tone: 'default' },
      { labelKey: 'media_card.mark_watched', icon: 'eye', tone: 'default' },
    ]);
  });

  it('season card already watched: the toggle swaps to unwatched/eye-off', async () => {
    const h = await createFixture(FULL_MEMBER, {
      link: ['/series', '1', 'season', '2'],
      interactiveWatched: true,
      status: 'watched',
    });
    expect(shapes(h)).toContainEqual({ labelKey: 'media_card.mark_unwatched', icon: 'eye-off', tone: 'default' });
  });

  it('minimal card (person/profile/search-external): link only — Open is the sole action', async () => {
    const h = await createFixture(FULL_MEMBER, { link: ['/movies', '3'] });
    expect(labels(h)).toEqual(['media_card.action_open']);
  });

  it('a card with no link and nothing else offers no actions at all', async () => {
    const h = await createFixture(FULL_MEMBER, {});
    expect(labels(h)).toEqual([]);
  });
});

describe('MediaCardComponent — card.actions role variance (Recommend only)', () => {
  const base = { link: ['/movies', '7'], playlistMediaId: 7, playable: true };

  it('full member sees Recommend', async () => {
    const h = await createFixture(FULL_MEMBER, base);
    expect(labels(h)).toContain('recommend.menu_item');
  });
  it('TV viewer never sees Recommend', async () => {
    const h = await createFixture(TV_VIEWER, base);
    expect(labels(h)).not.toContain('recommend.menu_item');
  });
  it('a sharing-disabled viewer never sees Recommend', async () => {
    const h = await createFixture(SHARING_DISABLED, base);
    expect(labels(h)).not.toContain('recommend.menu_item');
  });
});

describe('MediaCardComponent — card action handlers do what their row promises', () => {
  it('Play (play-intent) triggers the card click path — parent owns navigation via `clicked`, not a route push', async () => {
    const h = await createFixture(FULL_MEMBER, { link: ['/movies', '7'], playable: true, clickIntent: 'play' });
    const navigateSpy = vi.spyOn(h.router, 'navigate').mockResolvedValue(true);
    let clicked = false;
    h.fixture.componentInstance.clicked.subscribe(() => (clicked = true));
    findAction(h, 'media_card.action_play').run();
    expect(clicked).toBe(true);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('Play (non-play-intent) delegates to PlayableMediaService via a media file', async () => {
    const h = await createFixture(FULL_MEMBER, {
      media: makeMedia({ files: [{ id: 42, quality: '1080p', relativePath: 'x', size: 1 }] }),
    });
    findAction(h, 'media_card.action_play').run();
    expect(h.playableMedia.play).toHaveBeenCalled();
  });

  it('Open navigates to the detail link', async () => {
    const h = await createFixture(FULL_MEMBER, { link: ['/movies', '7'] });
    const navigateSpy = vi.spyOn(h.router, 'navigate').mockResolvedValue(true);
    findAction(h, 'media_card.action_open').run();
    expect(navigateSpy).toHaveBeenCalledWith(['/movies', '7'], expect.anything());
  });

  it('an episode card hands the still over, not a Media stub', async () => {
    const h = await createFixture(FULL_MEMBER, {
      link: ['/series', '5', 'episode', '42'],
      imageUrl: '/still.jpg',
    });
    const navigateSpy = vi.spyOn(h.router, 'navigate').mockResolvedValue(true);
    findAction(h, 'media_card.action_open').run();
    // The episode page resolves its episode out of the season tree, so it can
    // only use the still: it feeds the skeleton that carries the poster morph.
    expect(navigateSpy).toHaveBeenCalledWith(
      ['/series', '5', 'episode', '42'],
      expect.objectContaining({
        state: {
          episode: { id: 42, stillUrl: '/still.jpg', title: expect.anything(), label: null },
        },
      }),
    );
  });

  it('Add to playlist opens the modal with the resolved target', async () => {
    const h = await createFixture(FULL_MEMBER, { link: ['/movies', '7'], playlistMediaId: 7 });
    findAction(h, 'media_detail.add_to_list').run();
    expect(h.addToPlaylist.open).toHaveBeenCalledWith({ mediaId: 7 });
  });

  it('Recommend opens the modal with the resolved target', async () => {
    const h = await createFixture(FULL_MEMBER, { link: ['/movies', '7'], playlistMediaId: 7 });
    findAction(h, 'recommend.menu_item').run();
    expect(h.recommend.open).toHaveBeenCalledWith({ mediaId: 7, episodeId: undefined });
  });

  it('the watched toggle emits the target state', async () => {
    const h = await createFixture(FULL_MEMBER, { link: ['/movies', '7'], interactiveWatched: true, status: null });
    let emitted: boolean | undefined;
    h.fixture.componentInstance.watchedToggled.subscribe((v: boolean) => (emitted = v));
    findAction(h, 'media_card.mark_watched').run();
    expect(emitted).toBe(true);
  });

  it('Remove emits dismissed', async () => {
    const h = await createFixture(FULL_MEMBER, { link: ['/movies', '7'], dismissable: true });
    let dismissed = false;
    h.fixture.componentInstance.dismissed.subscribe(() => (dismissed = true));
    findAction(h, 'media_card.remove_from_list').run();
    expect(dismissed).toBe(true);
  });

  it('an extraActions row runs the caller-supplied callback verbatim, untouched by the registry', async () => {
    const run = vi.fn();
    const h = await createFixture(FULL_MEMBER, {
      link: ['/movies', '9'],
      dismissable: true,
      extraActions: [{ labelKey: 'x.custom', icon: 'eye', run }],
    });
    findAction(h, 'x.custom').run();
    expect(run).toHaveBeenCalled();
  });
});

// ── New in this PR: merging with plugin contributions. Meaningless before the
// registry existed, so these are additions, not part of the characterisation set above.

describe('MediaCardComponent — card.actions merges with plugin contributions', () => {
  it('sorts a plugin item into position by weight, between two core items', async () => {
    const h = await createFixture(
      FULL_MEMBER,
      { link: ['/movies', '7'], playlistMediaId: 7, playable: true },
      {
        'card.actions': [
          {
            id: 'fliks.acme.before',
            slot: 'card.actions',
            weight: 120,
            labelKey: 'x.before',
            action: { kind: 'route', path: '/plugins/acme/before' },
          },
          {
            id: 'fliks.acme.between',
            slot: 'card.actions',
            weight: 250,
            labelKey: 'x.between',
            action: { kind: 'route', path: '/plugins/acme/between' },
          },
          {
            id: 'fliks.acme.after',
            slot: 'card.actions',
            weight: 990,
            labelKey: 'x.after',
            action: { kind: 'route', path: '/plugins/acme/after' },
          },
        ],
      },
    );
    // Bracketed by two contributions of its own, so the assertion is about the
    // weight sort and nothing else — adding a core row cannot move it.
    const shown = labels(h);
    const at = (label: string) => shown.indexOf(label);
    expect(at('x.before')).toBeGreaterThanOrEqual(0);
    expect(at('x.between')).toBeGreaterThan(at('x.before'));
    expect(at('x.after')).toBeGreaterThan(at('x.between'));
    // and still interleaved with core's own rows, not appended after them
    expect(at('x.between')).toBeGreaterThan(at('media_card.action_open'));
  });

  it('a route-kind plugin action navigates on click', async () => {
    const h = await createFixture(
      FULL_MEMBER,
      {},
      {
        'card.actions': [
          { id: 'fliks.acme.route', slot: 'card.actions', weight: 50, labelKey: 'x.route', action: { kind: 'route', path: '/plugins/acme' } },
        ],
      },
    );
    const navigateSpy = vi.spyOn(h.router, 'navigate').mockResolvedValue(true);
    findAction(h, 'x.route').run();
    expect(navigateSpy).toHaveBeenCalledWith(['/plugins/acme']);
  });

  it('an unrecognised icon passes through as data — the generic-glyph fallback is the panel template\'s job', async () => {
    const h = await createFixture(
      FULL_MEMBER,
      {},
      {
        'card.actions': [
          { id: 'fliks.acme.weird-icon', slot: 'card.actions', weight: 50, labelKey: 'x.weird', icon: 'not-a-real-lucide-name', action: { kind: 'route', path: '/x' } },
        ],
      },
    );
    expect(findAction(h, 'x.weird').icon).toBe('not-a-real-lucide-name');
  });

  it('VERDICT: an unknown actionId renders no row — fail closed, not a dead click', async () => {
    const h = await createFixture(
      FULL_MEMBER,
      {},
      {
        'card.actions': [
          { id: 'fliks.acme.bogus-action', slot: 'card.actions', weight: 50, labelKey: 'x.bogus', action: { kind: 'action', actionId: 'card.something-invented' } },
        ],
      },
    );
    expect(labels(h)).not.toContain('x.bogus');
  });

  it('VERDICT: an unrecognised action.kind renders no row', async () => {
    const h = await createFixture(
      FULL_MEMBER,
      {},
      {
        'card.actions': [
          { id: 'fliks.acme.broken', slot: 'card.actions', weight: 50, labelKey: 'x.broken', action: { kind: 'bogus' } as never },
        ],
      },
    );
    expect(labels(h)).not.toContain('x.broken');
  });

  it('a plugin can reuse a core actionId (its handler), but must bring its own `when` — core\'s `when` is per-contribution, not per-actionId', async () => {
    const gatedRegistry = {
      'card.actions': [
        {
          id: 'fliks.acme.remove-alias',
          slot: 'card.actions' as const,
          weight: 850,
          labelKey: 'x.remove_alias',
          when: ['isTv' as const],
          action: { kind: 'action' as const, actionId: 'media.remove' },
        },
      ],
    };
    const notDismissable = await createFixture(FULL_MEMBER, { link: ['/movies', '7'], dismissable: false }, gatedRegistry);
    expect(labels(notDismissable)).not.toContain('x.remove_alias');

    const dismissableButNotTv = await createFixture(FULL_MEMBER, { link: ['/movies', '7'], dismissable: true }, gatedRegistry);
    expect(labels(dismissableButNotTv)).not.toContain('x.remove_alias');

    const dismissableAndTv = await createFixture(TV_VIEWER, { link: ['/movies', '7'], dismissable: true }, gatedRegistry);
    expect(labels(dismissableAndTv)).toContain('x.remove_alias');
  });

  it('a plugin cannot widen a core action: an alias with no `when` stays hidden from a role core hides it from (read-only), and shows for one core shows it to (can-delete)', async () => {
    const wideOpen = {
      'card.actions': [
        {
          id: 'fliks.acme.remove-wide',
          slot: 'card.actions' as const,
          weight: 850,
          labelKey: 'x.remove_wide',
          action: { kind: 'action' as const, actionId: 'media.remove' },
        },
      ],
    };
    const readOnly = await createFixture(FULL_MEMBER, { link: ['/movies', '7'], dismissable: false }, wideOpen);
    expect(labels(readOnly)).not.toContain('x.remove_wide');

    const canDelete = await createFixture(FULL_MEMBER, { link: ['/movies', '7'], dismissable: true }, wideOpen);
    expect(labels(canDelete)).toContain('x.remove_wide');

    // The alias's own handler is core's Remove handler — clicking it still emits `dismissed`.
    let dismissed = false;
    canDelete.fixture.componentInstance.dismissed.subscribe(() => (dismissed = true));
    findAction(canDelete, 'x.remove_wide').run();
    expect(dismissed).toBe(true);
  });

  it('the metadata group needs a library row: offered on a card bound to media, absent on a search-page card without one', async () => {
    const inLibrary = await createFixture(ADMIN, { media: makeMedia(), link: ['/movies', '5'] });
    expect(labels(inLibrary)).toContain('media_detail.metadata_group');
    const group = findAction(inLibrary, 'media_detail.metadata_group');
    expect(group.children.map((c: { labelKey: string }) => c.labelKey)).toEqual([
      'media_detail.identify',
      'media_detail.refresh_metadata',
    ]);

    // A discovery / external-search card carries no `media`, so Identify and
    // Refresh would be no-ops — the group must not be offered at all.
    const notInLibrary = await createFixture(ADMIN, { title: 'Not here', link: null });
    expect(labels(notInLibrary)).not.toContain('media_detail.metadata_group');
    expect(labels(notInLibrary)).not.toContain('media_detail.identify');
    expect(labels(notInLibrary)).not.toContain('media_detail.refresh_metadata');
  });
});

/**
 * Artwork placeholder. Android resolves cached posters over the Capacitor
 * bridge, so a card can hold an unpainted <img> for a frame or two at cold
 * start; a poster URL that outlived its file never paints at all. Both must
 * show the film glyph rather than the WebView's broken-image icon.
 */
describe('media-card artwork placeholder', () => {
  const placeholder = (h: Harness) =>
    h.fixture.nativeElement.querySelector('svg.lucide-film');
  const img = (h: Harness): HTMLImageElement | null =>
    h.fixture.nativeElement.querySelector('img');

  it('shows the placeholder with no poster at all', async () => {
    const h = await createFixture(FULL_MEMBER, { media: makeMedia() });
    expect(placeholder(h)).toBeTruthy();
    expect(img(h)).toBeNull();
  });

  it('keeps the placeholder until the poster actually loads', async () => {
    const h = await createFixture(FULL_MEMBER, {
      media: makeMedia({ posterUrl: '/api/images/1.jpg' }),
    });
    expect(placeholder(h)).toBeTruthy();
    expect(img(h)!.classList).toContain('opacity-0');

    img(h)!.dispatchEvent(new Event('load'));
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();

    expect(placeholder(h)).toBeNull();
    expect(img(h)!.classList).not.toContain('opacity-0');
  });

  it('falls back to the placeholder when the poster fails to load', async () => {
    const h = await createFixture(FULL_MEMBER, {
      media: makeMedia({ posterUrl: '/api/images/gone.jpg' }),
    });
    img(h)!.dispatchEvent(new Event('error'));
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();

    expect(img(h)).toBeNull();
    expect(placeholder(h)).toBeTruthy();
  });
});
