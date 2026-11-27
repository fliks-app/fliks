import { NgTemplateOutlet } from '@angular/common';
import { NO_ERRORS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, RouterLink, RouterLinkActive, provideRouter } from '@angular/router';
import { TranslateLoader, TranslatePipe, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import type { SlotId, UiContribution } from '@fliks/plugin-ui';
import { NavRailComponent } from './nav-rail';
import type { LibrarySummary } from '../../core/services/api/libraries-api.service';
import { AuthService } from '../../core/services/auth.service';
import { DeviceService } from '../../core/services/device.service';
import { LiveTvAvailabilityService } from '../../core/services/live-tv-availability.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import { NetworkService } from '../../core/services/network.service';
import { ServerVersionService } from '../../core/services/server-version.service';
import { TvService } from '../../core/services/tv.service';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import { LucideIconComponent } from '../components/lucide-icon';
import { PopoverMenuComponent } from '../components/popover-menu';
import { NavIconComponent } from '../layout/nav-icon';

const lib = (id: number, name: string, icon: string | null = null): LibrarySummary => ({
  id,
  name,
  icon,
  color: null,
  mediaTypes: ['movie'],
  defaultQualityProfileId: null,
  defaultLanguageProfileId: null,
  folders: [],
});

const FIVE = [lib(1, 'Movies'), lib(2, 'Series'), lib(3, 'Anime', 'swords'), lib(4, 'Music'), lib(5, 'Books')];

interface Setup {
  mode?: 'collapsed' | 'expanded';
  tv?: boolean;
  isAdmin?: boolean;
  libraries?: LibrarySummary[];
  badgeCounts?: Record<string, number>;
  registry?: Partial<Record<SlotId, UiContribution[]>>;
  url?: string;
  backdrop?: string;
}

async function setup(o: Setup = {}): Promise<{ fixture: ComponentFixture<NavRailComponent>; el: HTMLElement }> {
  TestBed.configureTestingModule({
    schemas: [NO_ERRORS_SCHEMA],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', children: [] }]),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: AuthService, useValue: { user: () => ({ id: 1, isAdmin: !!o.isAdmin }), hasPermission: () => true } },
      { provide: TvService, useValue: { isTv: () => !!o.tv } },
      { provide: DeviceService, useValue: { isTouch: () => false } },
      { provide: LiveTvAvailabilityService, useValue: { available: () => true } },
      { provide: ServerVersionService, useValue: { requestAdds: () => true, supports: () => true } },
      { provide: BackgroundService, useValue: { url: () => o.backdrop ?? null } },
      { provide: NetworkService, useValue: { isOnline: () => true } },
      { provide: PluginUiRegistryService, useValue: { contributionsFor: (slot: SlotId) => o.registry?.[slot] ?? [] } },
      {
        provide: NavbarService,
        useValue: {
          railMode: () => (o.tv ? 'collapsed' : (o.mode ?? 'collapsed')),
          railDocked: () => true,
          dockedBars: () => [],
        },
      },
    ],
  });
  TestBed.overrideComponent(NavRailComponent, {
    set: { schemas: [NO_ERRORS_SCHEMA], imports: [NgTemplateOutlet, RouterLink, RouterLinkActive, TranslatePipe, LucideIconComponent, NavIconComponent, PopoverMenuComponent] },
  });
  await TestBed.compileComponents();
  if (o.url) await TestBed.inject(Router).navigateByUrl(o.url);
  const fixture = TestBed.createComponent(NavRailComponent);
  fixture.componentRef.setInput('mode', o.mode ?? 'collapsed');
  fixture.componentRef.setInput('libraries', o.libraries ?? FIVE);
  fixture.componentRef.setInput('badgeCounts', o.badgeCounts ?? {});
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement };
}

/** Label, href and badge of each rail entry, in order. */
function entries(el: HTMLElement) {
  return Array.from(el.querySelectorAll('.rail-list li:not([role])')).map((li) => {
    const a = li.querySelector('a, button')!;
    return {
      label: (a.querySelector('.rail-label')?.textContent ?? '').trim(),
      href: a.getAttribute('href'),
      current: a.getAttribute('aria-current'),
    };
  });
}

describe('NavRailComponent', () => {
  it('is translucent over a backdrop and solid without one', async () => {
    const over = await setup({ backdrop: '/art.jpg' });
    const rail = over.el.querySelector('.nav-rail')!;
    expect(rail.classList.contains('app-sidebar-veil')).toBe(true);
    expect(rail.classList.contains('bg-base-100')).toBe(false);
    TestBed.resetTestingModule();
    expect((await setup()).el.querySelector('.nav-rail')!.classList.contains('bg-base-100')).toBe(true);
  });

  it('lists the first three libraries between the core items, then "Plus"', async () => {
    const { el } = await setup({ isAdmin: true });
    expect(entries(el)).toEqual([
      { label: 'nav.home', href: '/', current: null },
      { label: 'search.title', href: '/search', current: null },
      { label: 'liveTv.title', href: '/live-tv', current: null },
      { label: 'Movies', href: '/libraries/Movies', current: null },
      { label: 'Series', href: '/libraries/Series', current: null },
      { label: 'Anime', href: '/libraries/Anime', current: null },
      { label: 'nav.more', href: null, current: null },
      { label: 'nav.playlists', href: '/playlists', current: null },
      { label: 'downloads.title', href: '/downloads', current: null },
      { label: 'nav.history', href: '/history', current: null },
      { label: 'nav.requests', href: '/requests', current: null },
      { label: 'acquisition_queue.page_title', href: '/acquisition', current: null },
      { label: 'nav.calendar', href: '/calendar', current: null },
    ]);
  });

  it('has no "Plus" entry with three libraries or fewer', async () => {
    const { el } = await setup({ libraries: FIVE.slice(0, 3) });
    expect(entries(el).some((e) => e.label === 'nav.more')).toBe(false);
  });

  it('marks "Plus" current while the page is a library it holds', async () => {
    const { el } = await setup({ url: '/libraries/Books' });
    expect(entries(el).find((e) => e.label === 'nav.more')?.current).toBe('page');
  });

  it('keeps "Plus" unmarked on one of the first three libraries', async () => {
    const { el } = await setup({ url: '/libraries/Series' });
    expect(entries(el).find((e) => e.label === 'nav.more')?.current).toBeNull();
    expect(entries(el).find((e) => e.label === 'Series')?.current).toBe('page');
  });

  it('leaves out the acquisition entries and downloads on a TV', async () => {
    const { el } = await setup({ tv: true, isAdmin: true });
    const labels = entries(el).map((e) => e.label);
    expect(labels).not.toContain('nav.requests');
    expect(labels).not.toContain('nav.calendar');
    expect(labels).not.toContain('downloads.title');
    expect(el.querySelector('.rail-head button')).toBeNull();
  });

  it('shows a badge dot and a count for a badged entry', async () => {
    const { el } = await setup({ badgeCounts: { pendingRequests: 2 } });
    const requests = Array.from(el.querySelectorAll('.rail-list a')).find((a) => a.getAttribute('href') === '/requests')!;
    expect(requests.querySelector('.rail-dot')).not.toBeNull();
    expect(requests.querySelector('.rail-badge')?.textContent?.trim()).toBe('2');
  });

  it('renders a plugin entry with an unknown icon as a generic glyph and drops an unknown action', async () => {
    const { el } = await setup({
      registry: {
        'nav.main': [
          { id: 'a.weird', slot: 'nav.main', weight: 150, labelKey: 'x.weird', icon: 'nope', action: { kind: 'route', path: '/p/weird' } },
          { id: 'a.broken', slot: 'nav.main', weight: 160, labelKey: 'x.broken', action: { kind: 'bogus' } as never },
        ],
      },
    });
    const weird = Array.from(el.querySelectorAll('.rail-list a')).find((a) => a.getAttribute('href') === '/p/weird')!;
    expect(weird.querySelector('svg')?.classList.contains('lucide-circle')).toBe(true);
    expect(entries(el).some((e) => e.label === 'x.broken')).toBe(false);
  });

  it('rests collapsed, opens while focused from the keyboard or D-pad, and stays open when expanded', async () => {
    const { fixture, el } = await setup({ tv: true });
    const root = el.querySelector('.nav-rail')!;
    expect(root.classList.contains('rail-open')).toBe(false);
    document.documentElement.classList.add('tv-host');
    (el.querySelector('.rail-list a') as HTMLElement).dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    document.documentElement.classList.remove('tv-host');
    fixture.detectChanges();
    expect(root.classList.contains('rail-open')).toBe(true);
    (el.querySelector('.rail-list a') as HTMLElement).dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    fixture.detectChanges();
    expect(root.classList.contains('rail-open')).toBe(false);

    TestBed.resetTestingModule();
    const pinned = await setup({ mode: 'expanded' });
    expect(pinned.el.querySelector('.nav-rail')!.classList.contains('rail-open')).toBe(true);
  });

  it('opens on a first tap without following the link, and closes on a tap outside', async () => {
    const { fixture, el } = await setup();
    const root = el.querySelector('.nav-rail')!;
    const link = el.querySelector('.rail-list a') as HTMLElement;
    link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    const tap = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(tap);
    fixture.detectChanges();
    expect(tap.defaultPrevented).toBe(true);
    expect(root.classList.contains('rail-open')).toBe(true);

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    fixture.detectChanges();
    expect(root.classList.contains('rail-open')).toBe(false);
  });

  it('is an overlay-free list in the drawer: expanded, never reported as overlaying the page', async () => {
    const { fixture } = await setup({ mode: 'expanded' });
    const seen: boolean[] = [];
    fixture.componentInstance.overlaying.subscribe((v) => seen.push(v));
    fixture.detectChanges();
    expect(seen.every((v) => v === false)).toBe(true);
  });
});
