import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { DeviceService } from '../services/device.service';

/**
 * Restricts a route to the native desktop client (Electron). The in-app
 * self-update flow only exists there — web updates through the server, mobile
 * and TV through their store — so non-desktop hits redirect to the settings home.
 */
export const desktopGuard: CanActivateFn = () => {
  const device = inject(DeviceService);
  const router = inject(Router);
  if (device.isDesktopNative()) return true;
  return router.createUrlTree(['/app-settings/home']);
};
