import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../services/auth.service';

/** Accès réservé aux administrateurs (après authentification). */
export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.ensureAuthenticated().pipe(
    map((ok) => {
      if (!ok) return router.createUrlTree(['/login']);
      if (auth.user()?.role !== 'admin') {
        return router.createUrlTree(['/']);
      }
      return true;
    }),
  );
};
