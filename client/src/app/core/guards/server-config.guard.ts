import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ServerConfigService } from '../services/server-config.service';

export const serverConfigGuard: CanActivateFn = async () => {
  const config = inject(ServerConfigService);
  const router = inject(Router);

  if (!config.requiresServerUrl()) return true;

  await config.load();
  if (config.isConfigured()) return true;

  return router.createUrlTree(['/setup']);
};
