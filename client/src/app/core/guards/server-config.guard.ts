import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ServerConfigService } from '../services/server-config.service';

export const serverConfigGuard: CanActivateFn = () => {
  const config = inject(ServerConfigService);
  const router = inject(Router);

  // The stored URL is loaded before bootstrap (app.config.ts), so this is a
  // plain check — no await, no chance of running against an empty base.
  if (!config.isNative || config.isConfigured()) return true;

  return router.createUrlTree(['/setup']);
};
