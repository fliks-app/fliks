import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavContributionsService } from './nav-contributions.service';
import { PluginUiRegistryService } from './plugin-ui-registry.service';
import { AuthService } from '../services/auth.service';
import { TvService } from '../services/tv.service';
import { DeviceService } from '../services/device.service';
import type { SlotId, UiContribution } from '@fliks/plugin-contract/ui';

const contribution = (id: string, weight: number, overrides: Partial<UiContribution> = {}): UiContribution => ({
  id,
  slot: 'nav.main',
  weight,
  labelKey: `x.${id}`,
  action: { kind: 'route', path: `/plugins/x/${id}` },
  ...overrides,
});

function createService(opts: {
  registry?: Partial<Record<SlotId, UiContribution[]>>;
  isAdmin?: boolean;
  isTv?: boolean;
  userId?: number | null;
} = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: PluginUiRegistryService,
        useValue: { contributionsFor: (slot: SlotId) => opts.registry?.[slot] ?? [] },
      },
      {
        provide: AuthService,
        useValue: {
          user: () => (opts.userId === null ? null : { id: opts.userId ?? 1, isAdmin: !!opts.isAdmin }),
          hasPermission: () => false,
        },
      },
      { provide: TvService, useValue: { isTv: () => !!opts.isTv } },
      { provide: DeviceService, useValue: { isTouch: () => false } },
    ],
  });
  return TestBed.inject(NavContributionsService);
}

describe('NavContributionsService', () => {
  it('merges core with plugin contributions and sorts ascending by weight, ties break on id', () => {
    const svc = createService({
      registry: {
        'nav.main': [contribution('z-plugin', 300, { slot: 'nav.main' }), contribution('a-plugin', 300, { slot: 'nav.main' })],
      },
    });
    const ids = svc.mainItems().map((i) => i.id);
    // Both plugin items tie core's "My profile" (weight 300) — id order wins,
    // and stays the same regardless of which plugin installed first.
    expect(ids).toEqual(['core.home', 'core.search', 'a-plugin', 'core.my_profile', 'z-plugin', 'core.playlists', 'core.downloads', 'core.history']);
  });

  it('drops a contribution with an unknown action.kind — fails closed, never a broken item', () => {
    const svc = createService({
      registry: { 'nav.main': [contribution('broken', 150, { action: { kind: 'bogus' } as never })] },
    });
    expect(svc.mainItems().map((i) => i.id)).not.toContain('broken');
  });

  it('drops a core-declared action this client does not recognise', () => {
    const svc = createService({
      registry: { 'nav.main': [contribution('unknown-action', 150, { action: { kind: 'action', actionId: 'nothing.like.this' } })] },
    });
    expect(svc.mainItems().map((i) => i.id)).not.toContain('unknown-action');
  });

  it('resolves core.my_profile to the current user id', () => {
    const svc = createService({ userId: 42 });
    expect(svc.mainItems().find((i) => i.id === 'core.my_profile')?.route).toBe('/profile/42');
  });

  it('drops core.my_profile when there is no user id to build the route from', () => {
    const svc = createService({ userId: null });
    expect(svc.mainItems().map((i) => i.id)).not.toContain('core.my_profile');
  });

  it('hides an item whose `when` fails, and it never appears at all', () => {
    const svc = createService({
      registry: { 'nav.main': [contribution('admin-only', 150, { when: ['isAdmin'] })] },
      isAdmin: false,
    });
    expect(svc.mainItems().map((i) => i.id)).not.toContain('admin-only');
  });

  it('shows a `when`-gated item once its predicate passes', () => {
    const svc = createService({
      registry: { 'nav.main': [contribution('admin-only', 150, { when: ['isAdmin'] })] },
      isAdmin: true,
    });
    expect(svc.mainItems().map((i) => i.id)).toContain('admin-only');
  });

  it('hides core.my_profile and core.downloads on TV', () => {
    const svc = createService({ isTv: true });
    const ids = svc.mainItems().map((i) => i.id);
    expect(ids).not.toContain('core.my_profile');
    expect(ids).not.toContain('core.downloads');
  });

  it('passes an unrecognised icon through unchanged — the render layer decides the fallback glyph', () => {
    const svc = createService({
      registry: { 'nav.main': [contribution('weird-icon', 150, { icon: 'not-a-real-lucide-name' })] },
    });
    expect(svc.mainItems().find((i) => i.id === 'weird-icon')?.icon).toBe('not-a-real-lucide-name');
  });

  it('defaults a missing icon to the generic glyph key', () => {
    const svc = createService({
      registry: { 'nav.main': [contribution('no-icon', 150, { icon: undefined })] },
    });
    expect(svc.mainItems().find((i) => i.id === 'no-icon')?.icon).toBe('circle');
  });

  it('splits nav.main around the library block at weight 1000', () => {
    const svc = createService();
    expect(svc.mainItemsBeforeLibraries().map((i) => i.id)).toEqual(['core.home', 'core.search', 'core.my_profile']);
    expect(svc.mainItemsAfterLibraries().map((i) => i.id)).toEqual(['core.playlists', 'core.downloads', 'core.history']);
  });

  it('acquisition: core requests + calendar, weight 200 free for a plugin', () => {
    const svc = createService();
    expect(svc.acquisitionItems().map((i) => i.id)).toEqual(['core.requests', 'core.calendar']);
  });

  it('maps tone to a badge class: danger -> warning, default -> primary', () => {
    const svc = createService();
    const requests = svc.acquisitionItems().find((i) => i.id === 'core.requests');
    const calendar = svc.acquisitionItems().find((i) => i.id === 'core.calendar');
    expect(requests?.badgeClass).toBe('badge-warning');
    expect(calendar?.badgeClass).toBe('badge-primary');
  });
});
