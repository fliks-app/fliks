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
      // Skip: i18n files, parse errors, network/timeout errors, any error while offline
      const isNetworkError = err.status === 0 || err.status === 408 || err.status === 502 || err.status === 503 || err.status === 504 || (err as any).name === 'TimeoutError';
      if (req.url.includes('/i18n/') || err.status === 200 || isNetworkError || !navigator.onLine) {
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
