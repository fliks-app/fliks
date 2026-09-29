import { HttpContextToken, HttpInterceptorFn, HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, filter, throwError, timeout, TimeoutError } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { ToastService } from '../services/toast.service';
import { NetworkService } from '../services/network.service';
import { translatedServerMessage } from '../utils/server-message';

/** Set on a request whose failure the caller reports itself. For a batch: one summary beats N
 *  toasts, none of which could say which row they came from. */
export const SKIP_ERROR_TOAST = new HttpContextToken(() => false);

/** A black-holed link (VPN up, no route) never fails a request on its own. */
const API_GET_TIMEOUT_MS = 15_000;

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const toast = inject(ToastService);
  const translate = inject(TranslateService);
  const network = inject(NetworkService);
  const bounded = req.method === 'GET' && req.responseType === 'json' && req.url.includes('/api/');

  return next(req).pipe(
    // `Sent` fires at once; the deadline covers the wait for the answer.
    filter((e) => !bounded || e.type !== HttpEventType.Sent),
    bounded ? timeout(API_GET_TIMEOUT_MS) : (src) => src,
    catchError((caught: HttpErrorResponse | TimeoutError) => {
      const err =
        caught instanceof TimeoutError
          ? new HttpErrorResponse({ status: 0, statusText: 'Timeout', url: req.urlWithParams })
          : caught;
      if (err.status === 0 && req.url.includes('/api/')) network.reportDoubt();
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
      if (
        !showToast ||
        softMetadataGet ||
        healthProbe ||
        req.context.get(SKIP_ERROR_TOAST) ||
        req.url.includes('/i18n/')
      ) {
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
    const message = translatedServerMessage(body.message, translate);
    if (message) return message;
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
