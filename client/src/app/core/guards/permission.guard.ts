import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../services/auth.service';

/**
 * Bars a route from a user lacking `permission`. The sidebar entry carries the same predicate in
 * its `when`; this is what a typed URL hits, and what keeps a bookmark from reaching a 403 page.
 */
export function permissionGuard(permission: string): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);

    return auth.ensureAuthenticated().pipe(
      map((ok) => {
        if (!ok) return router.createUrlTree(['/login']);
        return auth.hasPermission(permission) ? true : router.createUrlTree(['/admin']);
      }),
    );
  };
}
