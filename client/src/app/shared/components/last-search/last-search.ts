import { Component, computed, inject, input } from '@angular/core';
import { LucideClock, LucideDownload } from '@lucide/angular';
import { TranslateService } from '@ngx-translate/core';
import type { LastSearch } from '../../../core/services/api/last-search.model';
import { translatePlural } from '../../../core/pipes/translate-plural.pipe';
import { formatRelativeTime } from '../../../core/utils/relative-time';

const REASON_KEY = 'last_search.reason.';

/** The one muted line saying what the last automatic search of a title found. `undefined` (a server that sends none) renders nothing; `null` is "not searched yet". */
@Component({
  selector: 'app-last-search',
  imports: [LucideClock, LucideDownload],
  templateUrl: './last-search.html',
})
export class LastSearchComponent {
  private readonly translate = inject(TranslateService);

  readonly search = input<LastSearch | null | undefined>(undefined);
  /** The state "grabbed" shows a download icon, the others a clock. */
  protected readonly grabbed = computed(() => this.search()?.outcome === 'grabbed');

  protected readonly text = computed(() => {
    const s = this.search();
    if (s === undefined) return null;
    if (s === null) return this.translate.instant('last_search.never');
    const lang = this.translate.currentLang() || 'en';
    const when = formatRelativeTime(s.at, lang);
    const t = (key: string, params?: object) => this.translate.instant(key, params);
    const main =
      s.outcome === 'grabbed' ? t('last_search.grabbed', { when }) : s.outcome === 'none' ? this.none(s, when) : t('last_search.unanswered', { when });
    const failed = s.failed.length ? t('last_search.failed', { names: s.failed.join(', ') }) : '';
    // A search already due reads as a time in the past, so it is not announced.
    const due = s.nextAt && Date.parse(s.nextAt) > Date.now() ? s.nextAt : null;
    const next = due ? t('last_search.next', { when: formatRelativeTime(due, lang) }) : '';
    return [main, failed, next].filter(Boolean).join(' ');
  });

  private none(s: LastSearch, when: string): string {
    if (s.found === 0) return this.translate.instant('last_search.found_none', { when });
    const reasons = s.rejections.map((r) => `${r.count} ${this.reason(r.code)}`).join(', ');
    return translatePlural(this.translate, reasons ? 'last_search.none_matched_why' : 'last_search.none_matched', s.found, { when, reasons });
  }

  private reason(code: string): string {
    const key = REASON_KEY + code;
    const label = this.translate.instant(key);
    return label === key ? this.translate.instant('last_search.reason_other') : label;
  }
}
