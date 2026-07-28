import {
  HttpErrorResponse,
  HttpEvent,
  HttpInterceptorFn,
  HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, Observable, switchMap, throwError } from 'rxjs';
import { ServerConfigService } from '../services/server-config.service';
import { AuthService } from '../services/auth.service';

/** True for the API of the server the app is signed into: a relative `/api`
 *  path, or an absolute URL under the configured base. */
export function targetsActiveServer(url: string, base: string): boolean {
  if (!url.includes('/api')) return false;
  if (!/^https?:\/\//i.test(url)) return true;
  if (!base) return false;
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * En mode web : envoie les cookies (session JWT) sur les appels API.
 * En mode natif (Capacitor) ou sur Smart TV : ajoute le header
 * Authorization Bearer. Les bundles standalone (Capacitor et TV) servent
 * depuis `file://` et ne reçoivent pas les cookies cross-origin, donc le
 * jeton doit voyager dans l'en-tête.
 *
 * Sur 401, on tente un refresh via le refresh-token stocké puis on
 * rejoue la requête originale avec le nouvel access token. La logique
 * single-flight (mutualisée côté AuthService) garantit qu'une rafale
 * de 401s simultanés ne déclenche qu'un seul rotate.
 */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  const serverConfig = inject(ServerConfigService);
  const auth = inject(AuthService);

  // Credentials only ever go to the active server. An absolute URL pointing
  // somewhere else is a probe of a host the user typed (setup's "test this
  // server"), and attaching the session to it would hand it to that host.
  if (!targetsActiveServer(req.url, serverConfig.serverUrl())) return next(req);

  // The refresh endpoint itself never gets the Bearer header (it
  // accepts only the body refreshToken) nor a retry loop — if it 401s
  // it's terminal.
  const isRefreshCall = req.url.includes('/api/auth/refresh');
  if (isRefreshCall) {
    return serverConfig.isNative
      ? next(req)
      : next(req.clone({ withCredentials: true }));
  }

  const attach = (r: HttpRequest<unknown>): HttpRequest<unknown> => {
    if (serverConfig.isNative) {
      const token = auth.accessToken;
      return token
        ? r.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
        : r;
    }
    return r.clone({ withCredentials: true });
  };

  return next(attach(req)).pipe(
    catchError((err: unknown) => {
      if (
        !(err instanceof HttpErrorResponse) ||
        err.status !== 401 ||
        !auth.refreshToken
      ) {
        return throwError(() => err);
      }
      // 401 with a refresh token available → try to rotate.
      return from(auth.refreshAccessToken()).pipe(
        switchMap((refreshed): Observable<HttpEvent<unknown>> => {
          if (!refreshed) {
            // Rotation failed: bubble the original 401 so the route
            // guard / error handler can react (redirect to login).
            return throwError(() => err);
          }
          // Retry with the fresh credentials — attach() reads them live
          // from auth.accessToken / the session cookie.
          return next(attach(req));
        }),
      );
    }),
  );
};
