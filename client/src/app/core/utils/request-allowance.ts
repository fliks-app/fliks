import type { TranslateService } from '@ngx-translate/core';
import { translatePlural } from '../pipes/translate-plural.pipe';
import type { KindAllowance } from '../services/api/requests.service';

export interface AllowanceLine {
  text: string;
  /** No request left in the window. */
  blocked: boolean;
}

const DAY_MS = 86_400_000;

/** "2 of 5 requests left per 7 days", or at zero "Limit reached, next request in 2 days". */
export function allowanceLine(translate: TranslateService, a: KindAllowance, now = Date.now()): AllowanceLine {
  const left = Math.max(0, a.limit - a.used);
  if (left > 0) {
    return { blocked: false, text: translatePlural(translate, 'requests.allowance_left', left, { limit: a.limit, days: a.periodDays }) };
  }
  const free = a.nextFreeAt ? Date.parse(a.nextFreeAt) : NaN;
  const days = Number.isNaN(free) ? a.periodDays : Math.max(1, Math.ceil((free - now) / DAY_MS));
  return { blocked: true, text: translatePlural(translate, 'requests.allowance_none', days) };
}
