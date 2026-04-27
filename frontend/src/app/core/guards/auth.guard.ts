import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.ensureAuthenticated().pipe(
    // Default landing for unauthenticated users is the user picker; the
    // password form lives behind it (or via /login direct deep link).
    map((ok) => (ok ? true : router.createUrlTree(['/select-user']))),
  );
};
