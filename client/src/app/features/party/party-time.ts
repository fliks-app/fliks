import type { TranslateService } from '@ngx-translate/core';

const DAY_MS = 86_400_000;

/** "Today at 21:00", "Tomorrow at 21:00", else a short weekday and date with the time. */
export function partyWhen(iso: string, translate: TranslateService, now = Date.now()): string {
  const d = new Date(iso);
  const lang = translate.currentLang() ?? undefined;
  const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const diff = Math.floor((new Date(d).setHours(0, 0, 0, 0) - midnight) / DAY_MS);
  if (diff === 0) return translate.instant('party.today_at', { time });
  if (diff === 1) return translate.instant('party.tomorrow_at', { time });
  const date = d.toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' });
  return translate.instant('party.date_at', { date, time });
}
