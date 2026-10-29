import { HttpErrorResponse } from '@angular/common/http';
import { ErrorHandler, Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ToastService } from './toast.service';

const TOAST_GAP_MS = 5000;

/** An uncaught error, or an unhandled rejection, tells the user instead of leaving a page stuck on its spinner. */
@Injectable()
export class AppErrorHandler implements ErrorHandler {
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private lastToastAt = 0;

  handleError(error: unknown): void {
    console.error(error);
    if (!actionable(error)) return;
    const now = Date.now();
    if (now - this.lastToastAt < TOAST_GAP_MS) return;
    this.lastToastAt = now;
    this.toast.error(this.translate.instant('common.unexpected_error'));
  }
}

/** An opaque cross-origin "Script error." (no error behind the event) or an aborted transition tells the user nothing;
 *  an HTTP failure was already reported, or kept quiet on purpose, by the error interceptor. */
function actionable(error: unknown): boolean {
  if (error instanceof HttpErrorResponse) return false;
  if (!(error instanceof Error)) return true;
  if (error.name === 'AbortError') return false;
  const cause = (error as { cause?: unknown }).cause;
  return !(typeof ErrorEvent !== 'undefined' && cause instanceof ErrorEvent && !cause.error);
}
