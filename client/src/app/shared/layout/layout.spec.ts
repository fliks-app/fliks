import { CORE_NAV_CONTRIBUTIONS } from '../../core/plugin-ui/core-contributions';
import { provideZonelessChangeDetection, NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { RouterLink, RouterLinkActive, RouterOutlet, provideRouter } from '@angular/router';
import { TranslateLoader, TranslateModule, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import {
  LucideMenu,
  LucideChevronLeft,
  LucideSearch,
  LucideCast,
  LucideEllipsisVertical,
  LucidePin,
  LucideRocket,
} from '@lucide/angular';
import { LayoutComponent } from './layout';
import { NavIconComponent } from './nav-icon';
import { LucideIconComponent } from '../components/lucide-icon';
import { TvRowDirective } from '../directives/tv-row.directive';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { AuthService } from '../../core/services/auth.service';
import { LibraryPrefsService } from '../../core/services/library-prefs.service';
import { LibrariesApiService, type LibrarySummary } from '../../core/services/api/libraries-api.service';
import { CountsApiService } from '../../core/services/api/counts-api.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { SseService } from '../../core/services/sse.service';
import { CastService } from '../../core/services/cast.service';
import { NavbarService } from '../../core/services/navbar.service';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { NavigationHistoryService } from '../../core/services/navigation-history.service';
import { NetworkService } from '../../core/services/network.service';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { RecommendService } from '../../core/services/recommend.service';
import { AppUpdateService } from '../../core/services/app-update.service';
import { BackgroundService } from '../../core/services/background.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { SlotId, UiContribution } from '../../core/plugin-ui/contribution.types';

// LayoutComponent reads `Capacitor.isNativePlatform()` at construction time to
// decide sidebar vs. phone-dock rendering — mocked so fixtures can force either.
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => nativeState.value },
  registerPlugin: () => ({ setLightStatusBar: () => Promise.resolve() }),
}));
vi.mock('@capacitor/keyboard', () => ({
  Keyboard: { addListener: () => {}, removeAllListeners: () => {} },
}));

interface Fixture {
  userId: number;
  isAdmin: boolean;
  device: { isDesktop?: boolean; isTablet?: boolean; isPhone?: boolean; isTv?: boolean; isTouch?: boolean };
  isTv: boolean;
  isNative: boolean;
  libraries: LibrarySummary[];
  queueActive: number;
  pendingRequests: number;
  registry?: Partial<Record<SlotId, UiContribution[]>>;
}

const lib = (id: number, name: string, opts: Partial<LibrarySummary> = {}): LibrarySummary => ({
  id,
  name,
  icon: null,
  color: null,
  mediaTypes: ['movie'],
  isDefaultForMovies: false,
  isDefaultForSeries: false,
  ...opts,
});

async function createFixture(f: Fixture): Promise<ComponentFixture<LayoutComponent>> {
  nativeState.value = f.isNative;

  TestBed.configureTestingModule({
    schemas: [NO_ERRORS_SCHEMA],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: Title, useValue: { setTitle: () => {} } },
      {
        provide: AuthService,
        useValue: { user: () => ({ id: f.userId, isAdmin: f.isAdmin }), hasPermission: () => false },
      },
      { provide: LibraryPrefsService, useValue: { present: (libs: LibrarySummary[]) => libs } },
      { provide: LibrariesApiService, useValue: { listMine: () => Promise.resolve(f.libraries) } },
      {
        provide: CountsApiService,
        useValue: {
          get: () =>
            Promise.resolve({ mediaByLibrary: {}, queueActive: f.queueActive, pendingRequests: f.pendingRequests }),
        },
      },
      { provide: ServerConfigService, useValue: {} },
      { provide: SseService, useValue: { lastEvent: () => null, connect: () => {} } },
      { provide: DownloadManagerService, useValue: {} },
      { provide: NavigationHistoryService, useValue: { resetNavHistory: () => {} } },
      { provide: AddToPlaylistService, useValue: { request: () => null, clear: () => {} } },
      { provide: RecommendService, useValue: { request: () => null, clear: () => {} } },
      { provide: NetworkService, useValue: { isOnline: () => true } },
      {
        provide: CastService,
        useValue: { isAvailable: () => false, connecting: () => false, isConnected: () => false, disconnect: () => {}, requestSession: () => {} },
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
        },
      },
      { provide: BackgroundService, useValue: { url: () => null } },
      { provide: SearchStateService, useValue: { requestFocus: () => {} } },
      {
        provide: TvService,
        useValue: { isTv: () => f.isTv, isTizen: () => false, isAndroidTv: () => false, isWebOs: () => false },
      },
      {
        provide: DeviceService,
        useValue: {
          isDesktop: () => !!f.device.isDesktop,
          isTablet: () => !!f.device.isTablet,
          isPhone: () => !!f.device.isPhone,
          isTv: () => !!f.device.isTv,
          isTouch: () => !!f.device.isTouch,
        },
      },
      {
        provide: CastPlayerService,
        useValue: { hasMedia: () => false, mediaTitle: () => '', expanded: { update: () => {} } },
      },
      { provide: AppUpdateService, useValue: { available: () => false } },
      {
        provide: PluginUiRegistryService,
        useValue: { contributionsFor: (slot: SlotId) => f.registry?.[slot] ?? [] },
      },
    ],
  });

  // Replace the component's `imports` to drop child components unrelated to
  // nav (cast, modals, user menu, background) so their own DI graphs never
  // need stubbing — their now-unmatched tags fall through to NO_ERRORS_SCHEMA.
  TestBed.overrideComponent(LayoutComponent, {
    set: {
      schemas: [NO_ERRORS_SCHEMA],
      imports: [
        RouterOutlet, RouterLink, RouterLinkActive, TranslateModule,
        LucideMenu, LucideChevronLeft, LucideSearch, LucideCast, LucideEllipsisVertical, LucidePin, LucideRocket,
        LucideIconComponent,
        NavIconComponent,
        TvRowDirective,
        ResolveUrlPipe,
      ],
    },
  });

  const fixture = TestBed.createComponent(LayoutComponent);
  fixture.detectChanges();
  // ngOnInit's own refreshCounts() is fire-and-forget (a plain Promise, not
  // tracked by zoneless `whenStable()`) — await it directly for determinism.
  await fixture.componentInstance.refreshCounts();
  fixture.detectChanges();
  return fixture;
}

interface CapturedItem {
  label: string;
  icon: string | null;
  badge: string | null;
  href: string | null;
}

function readItem(anchor: Element | null): CapturedItem | null {
  if (!anchor) return null;
  const badgeEl = anchor.querySelector('.badge');
  const badge = badgeEl ? (badgeEl.textContent ?? '').trim() : null;
  const svg = anchor.querySelector('svg');
  const icon = svg
    ? (Array.from(svg.attributes).map((a) => a.name).find((n) => n.startsWith('lucide')) ?? null)
    : null;
  const labelHost = anchor.querySelector(':scope > span:not(.badge)') ?? anchor;
  const label = (labelHost.textContent ?? '').trim();
  return { label, icon, badge, href: anchor.getAttribute('href') };
}

function sidebarItems(root: HTMLElement): CapturedItem[] {
  return Array.from(root.querySelectorAll('aside ul.menu > li'))
    .map((li) => readItem(li.querySelector('a')))
    .filter((x): x is CapturedItem => x !== null);
}

function dockItems(root: HTMLElement): CapturedItem[] {
  const dock = root.querySelector('.dock');
  if (!dock) return [];
  return Array.from(dock.children)
    .filter((c) => c.tagName === 'A' || c.tagName === 'BUTTON')
    .map((c) => readItem(c))
    .filter((x): x is CapturedItem => x !== null);
}

function sheetItems(root: HTMLElement): CapturedItem[] {
  const sidebarMenu = root.querySelector('aside ul.menu');
  const sheetMenu = Array.from(root.querySelectorAll('ul.menu')).find((m) => m !== sidebarMenu);
  if (!sheetMenu) return [];
  return Array.from(sheetMenu.querySelectorAll('li'))
    .map((li) => readItem(li.querySelector('a')))
    .filter((x): x is CapturedItem => x !== null);
}

function searchFab(root: HTMLElement): CapturedItem | null {
  return readItem(root.querySelector('a[href="/search"]'));
}

const ADMIN_WITH_LIBRARIES: Fixture = {
  userId: 1,
  isAdmin: true,
  device: { isDesktop: true },
  isTv: false,
  isNative: false,
  libraries: [
    lib(1, 'Movies', { isDefaultForMovies: true }),
    lib(2, 'Series', { isDefaultForSeries: true }),
    lib(3, 'Anime', { icon: 'swords' }),
  ],
  queueActive: 3,
  pendingRequests: 2,
};

const NON_ADMIN_NO_LIBRARIES: Fixture = {
  userId: 2,
  isAdmin: false,
  device: { isTablet: true },
  isTv: false,
  isNative: false,
  libraries: [],
  queueActive: 0,
  pendingRequests: 0,
};

const TV_FORM_FACTOR: Fixture = {
  userId: 3,
  isAdmin: false,
  device: { isTv: true },
  isTv: true,
  isNative: false,
  libraries: [lib(1, 'Movies', { isDefaultForMovies: true })],
  queueActive: 1,
  pendingRequests: 0,
};

const NATIVE_PHONE: Fixture = {
  userId: 4,
  isAdmin: false,
  device: { isPhone: true, isTouch: true },
  isTv: false,
  isNative: true,
  libraries: [
    lib(1, 'Movies', { isDefaultForMovies: true }),
    lib(2, 'Series', { isDefaultForSeries: true }),
    lib(3, 'Anime', { icon: 'swords' }),
  ],
  queueActive: 5,
  pendingRequests: 1,
};

describe('LayoutComponent nav — characterisation (data, not pixels)', () => {
  afterEach(() => {
    nativeState.value = false;
  });

  it('sidebar: admin with libraries', async () => {
    const fixture = await createFixture(ADMIN_WITH_LIBRARIES);
    expect(sidebarItems(fixture.nativeElement)).toEqual([
      { label: 'nav.home', icon: 'lucideHome', badge: null, href: '/' },
      { label: 'search.title', icon: 'lucideSearch', badge: null, href: '/search' },
      { label: 'nav.my_profile', icon: 'lucideUserRound', badge: null, href: '/profile/1' },
      { label: 'Movies', icon: 'lucideLibrary', badge: null, href: '/libraries/Movies' },
      { label: 'Series', icon: 'lucideLibrary', badge: null, href: '/libraries/Series' },
      { label: 'Anime', icon: 'lucideSwords', badge: null, href: '/libraries/Anime' },
      { label: 'nav.playlists', icon: 'lucideListVideo', badge: null, href: '/playlists' },
      { label: 'downloads.title', icon: 'lucideDownload', badge: null, href: '/downloads' },
      { label: 'nav.history', icon: 'lucideHistory', badge: null, href: '/history' },
      { label: 'nav.requests', icon: 'lucideClipboardList', badge: '2', href: '/requests' },
      { label: 'nav.activity', icon: 'lucideDownload', badge: '3', href: '/activity' },
      { label: 'nav.calendar', icon: 'lucideCalendar', badge: null, href: '/calendar' },
    ]);
    expect(dockItems(fixture.nativeElement)).toEqual([]);
    expect(sheetItems(fixture.nativeElement)).toEqual([]);
  });

  it('sidebar: non-admin without libraries', async () => {
    const fixture = await createFixture(NON_ADMIN_NO_LIBRARIES);
    expect(sidebarItems(fixture.nativeElement)).toEqual([
      { label: 'nav.home', icon: 'lucideHome', badge: null, href: '/' },
      { label: 'search.title', icon: 'lucideSearch', badge: null, href: '/search' },
      { label: 'nav.my_profile', icon: 'lucideUserRound', badge: null, href: '/profile/2' },
      { label: 'nav.playlists', icon: 'lucideListVideo', badge: null, href: '/playlists' },
      { label: 'downloads.title', icon: 'lucideDownload', badge: null, href: '/downloads' },
      { label: 'nav.history', icon: 'lucideHistory', badge: null, href: '/history' },
      { label: 'nav.requests', icon: 'lucideClipboardList', badge: null, href: '/requests' },
      { label: 'nav.activity', icon: 'lucideDownload', badge: null, href: '/activity' },
      { label: 'nav.calendar', icon: 'lucideCalendar', badge: null, href: '/calendar' },
    ]);
  });

  it('sidebar: TV form factor hides My profile and Downloads', async () => {
    const fixture = await createFixture(TV_FORM_FACTOR);
    expect(sidebarItems(fixture.nativeElement)).toEqual([
      { label: 'nav.home', icon: 'lucideHome', badge: null, href: '/' },
      { label: 'search.title', icon: 'lucideSearch', badge: null, href: '/search' },
      { label: 'Movies', icon: 'lucideLibrary', badge: null, href: '/libraries/Movies' },
      { label: 'nav.playlists', icon: 'lucideListVideo', badge: null, href: '/playlists' },
      { label: 'nav.history', icon: 'lucideHistory', badge: null, href: '/history' },
      { label: 'nav.requests', icon: 'lucideClipboardList', badge: null, href: '/requests' },
      { label: 'nav.activity', icon: 'lucideDownload', badge: '1', href: '/activity' },
      { label: 'nav.calendar', icon: 'lucideCalendar', badge: null, href: '/calendar' },
    ]);
  });

  it('native phone: dock primary row is Home, Downloads, Requests + the search FAB', async () => {
    const fixture = await createFixture(NATIVE_PHONE);
    expect(dockItems(fixture.nativeElement)).toEqual([
      { label: 'nav.home', icon: 'lucideHome', badge: null, href: '/' },
      // The dock keeps its own abbreviated label via `shortLabelKey`; the sidebar
      // and the sheet render the full one. Identical to the pre-refactor markup.
      { label: 'nav.downloads', icon: 'lucideDownload', badge: null, href: '/downloads' },
      { label: 'nav.requests', icon: 'lucideClipboardList', badge: null, href: '/requests' },
      { label: 'nav.more', icon: 'lucideEllipsisVertical', badge: null, href: null },
    ]);
    expect(searchFab(fixture.nativeElement)).toEqual({
      label: '',
      icon: 'lucideSearch',
      badge: null,
      href: '/search',
    });
  });

  it('native phone: the more-sheet holds everything not pinned to the dock', async () => {
    const fixture = await createFixture(NATIVE_PHONE);
    fixture.componentInstance.bottomMenuOpen.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Deliberate change: the sheet used to hand-order main/acquisition items
    // (Activity before History); it now renders each group by weight, main
    // items first then acquisition items, so Activity (weight 200) now
    // trails History (weight 2200) — a side effect of one ordering rule
    // replacing the old ad-hoc markup order.
    expect(sheetItems(fixture.nativeElement)).toEqual([
      { label: 'Anime', icon: 'lucideSwords', badge: null, href: '/libraries/Anime' },
      { label: 'nav.playlists', icon: 'lucideListVideo', badge: null, href: '/playlists' },
      { label: 'nav.history', icon: 'lucideHistory', badge: null, href: '/history' },
      { label: 'nav.activity', icon: 'lucideDownload', badge: '5', href: '/activity' },
      { label: 'nav.calendar', icon: 'lucideCalendar', badge: null, href: '/calendar' },
    ]);
  });

  it('a plugin contribution with an unknown icon renders a generic glyph, never a blank space', async () => {
    const fixture = await createFixture({
      ...NATIVE_PHONE,
      registry: {
        'nav.acquisition': [
          {
            id: 'fliks.acme.weird-icon',
            slot: 'nav.acquisition',
            weight: 150,
            labelKey: 'x.weird',
            icon: 'not-a-real-lucide-name',
            action: { kind: 'route', path: '/plugins/acme/weird' },
          },
        ],
      },
    });
    fixture.componentInstance.bottomMenuOpen.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const inSidebar = sidebarItems(fixture.nativeElement).find((i) => i.label === 'x.weird');
    const inSheet = sheetItems(fixture.nativeElement).find((i) => i.label === 'x.weird');
    expect(inSidebar?.icon).toBe('lucideCircle');
    expect(inSheet?.icon).toBe('lucideCircle');
  });

  it('a plugin contribution with an unknown action.kind never renders — fails closed, not blank', async () => {
    const fixture = await createFixture({
      ...ADMIN_WITH_LIBRARIES,
      registry: {
        'nav.main': [
          { id: 'fliks.acme.broken', slot: 'nav.main', weight: 150, labelKey: 'x.broken', action: { kind: 'bogus' } as never },
        ],
      },
    });
    expect(sidebarItems(fixture.nativeElement).some((i) => i.label === 'x.broken')).toBe(false);
  });

  it('a `when`-hidden plugin contribution is absent from the sidebar, the dock and the sheet alike', async () => {
    const fixture = await createFixture({
      ...NATIVE_PHONE,
      registry: {
        'nav.main': [
          {
            id: 'fliks.acme.admin-only',
            slot: 'nav.main',
            weight: 150,
            labelKey: 'x.admin_only',
            when: ['isAdmin'],
            action: { kind: 'route', path: '/plugins/acme/admin' },
          },
        ],
      },
    });
    fixture.componentInstance.bottomMenuOpen.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // NATIVE_PHONE is a non-admin fixture, so the gated item must show up nowhere.
    expect(sidebarItems(fixture.nativeElement).some((i) => i.label === 'x.admin_only')).toBe(false);
    expect(dockItems(fixture.nativeElement).some((i) => i.label === 'x.admin_only')).toBe(false);
    expect(sheetItems(fixture.nativeElement).some((i) => i.label === 'x.admin_only')).toBe(false);
  });

  it('renders the full label everywhere except the compact dock, which prefers shortLabelKey', async () => {
    // `/downloads` is the on-device offline page, unrelated to the acquisition plugin — its
    // per-surface labels predate this work and must survive it.
    const downloads = CORE_NAV_CONTRIBUTIONS.find((c) => c.id === 'core.downloads');

    expect(downloads?.labelKey).toBe('downloads.title');
    expect(downloads?.shortLabelKey).toBe('nav.downloads');
  });
});
