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

/** Web: sends cookies; native (Capacitor) and Smart TV: adds `Authorization: Bearer`, as `file://` bundles get no cross-origin cookies.
 * On 401, refreshes once (single-flight in AuthService) and replays the request. */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  const serverConfig = inject(ServerConfigService);
  const auth = inject(AuthService);

  // Credentials go only to the active server: an absolute URL elsewhere is a typed host being probed.
  if (!targetsActiveServer(req.url, serverConfig.serverUrl())) return next(req);

  // The refresh endpoint takes only the body refreshToken, never the Bearer header or a retry; its 401 is terminal.
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
