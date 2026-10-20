import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { TvService } from '../services/tv.service';

/** Bars TV form factors from personal-device offline-download routes: no 10-foot use case, and Capacitor/IndexedDB storage is unavailable there. */
export const noTvGuard: CanActivateFn = () => {
  const tv = inject(TvService);
  const router = inject(Router);
  if (tv.isTv()) return router.createUrlTree(['/']);
  return true;
};
