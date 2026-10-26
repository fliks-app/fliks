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
    const now = Date.now();
    if (now - this.lastToastAt < TOAST_GAP_MS) return;
    this.lastToastAt = now;
    this.toast.error(this.translate.instant('common.unexpected_error'));
  }
}
