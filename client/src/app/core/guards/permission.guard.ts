import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../services/auth.service';

/** Bars a route from a user lacking `permission` (typed URLs and bookmarks, which the sidebar `when` doesn't cover); `redirectTo` defaults to the admin shell. */
export function permissionGuard(permission: string, redirectTo = '/admin'): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);

    return auth.ensureAuthenticated().pipe(
      map((ok) => {
        if (!ok) return router.createUrlTree(['/login']);
        return auth.hasPermission(permission) ? true : router.createUrlTree([redirectTo]);
      }),
    );
  };
}
