import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/** Sends a server with no account yet to the first-admin page. */
export const setupGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return (await auth.setupRequired()) ? router.createUrlTree(['/create-admin']) : true;
};
