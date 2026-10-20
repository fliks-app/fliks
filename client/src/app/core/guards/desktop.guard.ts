import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { DeviceService } from '../services/device.service';

/** Restricts a route to the native desktop client (Electron), the only place the in-app self-update exists; others redirect to settings home. */
export const desktopGuard: CanActivateFn = () => {
  const device = inject(DeviceService);
  const router = inject(Router);
  if (device.isDesktopNative()) return true;
  return router.createUrlTree(['/app-settings/home']);
};
