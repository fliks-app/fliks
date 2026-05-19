import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { TvService } from '../services/tv.service';

/**
 * Bars TV form factors (AndroidTV / Tizen / webOS) from a route. Used on
 * personal-device offline-download flows that have no 10-foot use case
 * and whose Capacitor / IndexedDB-backed storage is unavailable on smart
 * TV web runtimes.
 */
export const noTvGuard: CanActivateFn = () => {
  const tv = inject(TvService);
  const router = inject(Router);
  if (tv.isTv()) return router.createUrlTree(['/']);
  return true;
};
