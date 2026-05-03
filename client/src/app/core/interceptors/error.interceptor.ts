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
      // Show toasts for client errors (400-499 except 408) + 500.
      // Skip: i18n, network errors, gateway errors, timeouts, offline, and
      // 401 — the auth guard handles unauth state by redirecting to the user
      // picker; toasting the 401 just adds noise on top of that flow.
      const showToast = (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 401) || err.status === 500;
      if (!showToast || req.url.includes('/i18n/')) {
        return throwError(() => err);
      }
      const message = extractMessage(err, translate);
      toast.error(message);
      return throwError(() => err);
    }),
  );
};

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

  if (body?.message) {
    return Array.isArray(body.message) ? body.message.join(', ') : body.message;
  }

  const key = `errors.${err.status}`;
  const translated = translate.instant(key);
  if (translated !== key) {
    return translated;
  }

  return translate.instant('errors.unknown', { code: err.status });
}
