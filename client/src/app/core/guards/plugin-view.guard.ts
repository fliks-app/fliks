import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { TvService } from '../services/tv.service';
import { DeviceService } from '../services/device.service';
import { PluginUiRegistryService } from '../plugin-ui/plugin-ui-registry.service';
import { evaluateWhen } from '../plugin-ui/when-evaluator';

/**
 * Keeps a plugin page from being reachable by a user its own contribution's
 * `when` would hide it from. Presentation only — an unknown plugin/view is
 * the component's "unavailable" state, not a guard concern; the proxied
 * routes a page calls are CASL-guarded server-side regardless of this check.
 */
export const pluginViewGuard: CanActivateFn = (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const registry = inject(PluginUiRegistryService);
  const tv = inject(TvService);
  const device = inject(DeviceService);

  return auth.ensureAuthenticated().pipe(
    map((ok) => {
      if (!ok) return router.createUrlTree(['/login']);

      const path = state.url.split('?')[0];
      const contribution = registry.findRouteContribution(path);
      if (!contribution) return true;

      const visible = evaluateWhen(contribution.when, {
        isAdmin: auth.user()?.isAdmin ?? false,
        hasPermission: (p) => auth.hasPermission(p),
        isTv: tv.isTv(),
        isTouch: device.isTouch(),
      });
      return visible ? true : router.createUrlTree(['/']);
    }),
  );
};
