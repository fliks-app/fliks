import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { OptimizeService } from './api/optimize.service';
import { ConfirmationService } from './confirmation.service';

/** The confirmation before several files are rewritten: their count and what happens to the originals. */
@Injectable({ providedIn: 'root' })
export class OptimizeConfirmService {
  private readonly api = inject(OptimizeService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);

  async confirmRewrite(count: number, confirmLabel: string): Promise<boolean> {
    let policy;
    try {
      policy = (await this.api.settings()).optimizeOriginal;
    } catch {
      return false;
    }
    const t = (key: string, params?: object) => this.translate.instant(key, params);
    const message = [
      t('optimize.action.confirm_files', { count }),
      t(`settings.optimize.global.original_${policy}`),
      ...(policy === 'delete' ? [t('settings.optimize.global.delete_warning')] : []),
    ].join(' ');
    return this.confirmation.confirm({
      title: t('optimize.action.confirm_title'),
      message,
      confirmLabel,
      cancelLabel: t('common.cancel'),
      variant: policy === 'delete' ? 'danger' : 'warning',
    });
  }
}
