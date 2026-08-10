import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UrlTree, provideRouter } from '@angular/router';
import { firstValueFrom, isObservable, of } from 'rxjs';
import { pluginViewGuard } from './plugin-view.guard';
import { AuthService } from '../services/auth.service';
import { TvService } from '../services/tv.service';
import { DeviceService } from '../services/device.service';
import { PluginUiRegistryService } from '../plugin-ui/plugin-ui-registry.service';
import type { UiContribution, WhenPredicate } from '../plugin-ui/contribution.types';

const routeState = (url: string) => ({ url }) as never;

function setup(opts: {
  authenticated?: boolean;
  isAdmin?: boolean;
  contribution?: UiContribution;
}) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: AuthService,
        useValue: {
          ensureAuthenticated: () => of(opts.authenticated ?? true),
          user: () => ({ isAdmin: opts.isAdmin ?? false }),
          hasPermission: () => false,
        },
      },
      { provide: TvService, useValue: { isTv: () => false } },
      { provide: DeviceService, useValue: { isTouch: () => false } },
      {
        provide: PluginUiRegistryService,
        useValue: { findRouteContribution: () => opts.contribution },
      },
    ],
  });
}

const runGuard = async (url: string) => {
  const result = TestBed.runInInjectionContext(() => pluginViewGuard({} as never, routeState(url)));
  return isObservable(result) ? firstValueFrom(result) : result;
};

const contribution = (when?: WhenPredicate[]): UiContribution => ({
  id: 'fliks.a.item',
  slot: 'nav.main',
  weight: 100,
  labelKey: 'x',
  when,
  action: { kind: 'route', path: '/plugins/fliks.a/item' },
});

describe('pluginViewGuard', () => {
  it('redirects to /login when not authenticated', async () => {
    setup({ authenticated: false });
    const result = await runGuard('/plugins/fliks.a/item');
    expect(result).toBeInstanceOf(UrlTree);
  });

  it('lets the route through when no contribution links to this exact path — the component renders "unavailable" instead', async () => {
    setup({ contribution: undefined });
    const result = await runGuard('/plugins/fliks.unknown/item');
    expect(result).toBe(true);
  });

  it('lets the route through when the matching contribution has no when', async () => {
    setup({ contribution: contribution() });
    const result = await runGuard('/plugins/fliks.a/item');
    expect(result).toBe(true);
  });

  it('redirects home when the contribution when hides it from this user', async () => {
    setup({ isAdmin: false, contribution: contribution(['isAdmin']) });
    const result = await runGuard('/plugins/fliks.a/item');
    expect(result).toBeInstanceOf(UrlTree);
  });

  it('lets an admin through an isAdmin-gated page', async () => {
    setup({ isAdmin: true, contribution: contribution(['isAdmin']) });
    const result = await runGuard('/plugins/fliks.a/item');
    expect(result).toBe(true);
  });

  it('strips the query string before matching the contribution path', async () => {
    setup({ contribution: contribution(['isAdmin']), isAdmin: false });
    const result = await runGuard('/plugins/fliks.a/item?foo=bar');
    expect(result).toBeInstanceOf(UrlTree);
  });
});
