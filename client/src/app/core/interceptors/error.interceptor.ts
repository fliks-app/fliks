import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { ToastService } from '../services/toast.service';

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const toast = inject(ToastService);
  const translate = inject(TranslateService);

  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      // Show toasts for client errors (400-499 except 408) + 500 + 503.
      // Skip: i18n, network errors, gateway errors, timeouts, offline, and
      // 401 — the auth guard handles unauth state by redirecting to the user
      // picker; toasting the 401 just adds noise on top of that flow. 503 is
      // what an installed-but-unreachable plugin returns — the one 5xx an
      // admin most needs surfaced.
      const showToast =
        (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 401) ||
        err.status === 500 ||
        err.status === 503;
      // Discover/search/browse GETs degrade in place (stale cache or empty
      // rows), so an upstream 500 there must not spray toasts — one discover
      // open fires several parallel metadata calls at once.
      const softMetadataGet =
        req.method === 'GET' && req.url.includes('/api/metadata') && err.status === 500;
      // Health is polled while the server restarts, so a failed probe is expected.
      const healthProbe = req.url.includes('/api/system/health');
      if (!showToast || softMetadataGet || healthProbe || req.url.includes('/i18n/')) {
        return throwError(() => err);
      }
      const message = extractMessage(err, translate);
      toast.error(message);
      return throwError(() => err);
    }),
  );
};

/** Nest's own 404 for a route nothing serves (`Cannot ${method} ${url}`) — a
 *  raw URL a user has no context for, never a message the app itself wrote. */
function isFrameworkNotFound(status: number, message: unknown): boolean {
  return status === 404 && typeof message === 'string' && /^Cannot [A-Z]+ /.test(message);
}

function extractMessage(
  err: HttpErrorResponse,
  translate: TranslateService,
): string {
  if (err.status === 0) {
    return translate.instant('errors.network');
  }

  const body = err.error;

  if (typeof body === 'string') {
    return body;
  }

  if (body?.message && !isFrameworkNotFound(err.status, body.message)) {
    if (Array.isArray(body.message)) return body.message.join(', ');
    // Backends may return an i18n key for user-facing validation errors
    // (English-only rule keeps the copy out of the API); translate it when
    // known, otherwise show the message as-is.
    const msg = body.message as string;
    const translated = translate.instant(msg);
    return translated !== msg ? translated : msg;
  }

  // A plugin route answers `{error:{key,detail}}`; its keys are merged into the catalogue on
  // install. A status sentence would contradict the reason the plugin already named.
  const pluginKey = body?.error?.key;
  if (typeof pluginKey === 'string' && pluginKey) {
    const translated = translate.instant(pluginKey, { detail: body.error.detail });
    if (translated !== pluginKey) return translated;
    const detail = body.error.detail;
    return typeof detail === 'string' && detail
      ? detail
      : translate.instant('errors.unknown', { code: err.status });
  }

  const key = `errors.${err.status}`;
  const translated = translate.instant(key);
  if (translated !== key) {
    return translated;
  }

  return translate.instant('errors.unknown', { code: err.status });
}
