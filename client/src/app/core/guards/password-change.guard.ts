import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Pins users with `requirePasswordChange = true` on the dedicated
 * /forced-password-change page until they set a new password. Reads the user
 * synchronously from AuthService.user() — only valid AFTER authGuard has run,
 * so route configs must always list authGuard first.
 */
export const passwordChangeGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = auth.user();
  if (user?.requirePasswordChange && !state.url.startsWith('/forced-password-change')) {
    return router.createUrlTree(['/forced-password-change']);
  }
  return true;
};
