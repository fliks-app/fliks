/**
 * Format an ISO/Date timestamp as a localized relative-time string ("il y a
 * 5 min", "in 2 days"). Wraps Intl.RelativeTimeFormat so all sites that
 * previously hand-rolled the unit ladder (admin user list, server history,
 * pending requests, user stats) share one implementation.
 */
export function formatRelativeTime(value: string | Date | null | undefined, locale = 'fr'): string {
  if (!value) return '';
  const ts = typeof value === 'string' ? new Date(value).getTime() : value.getTime();
  if (Number.isNaN(ts)) return '';
  const diffMs = Date.now() - ts;
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minutes = Math.round(diffMs / 60000);
  if (Math.abs(minutes) < 1) return fmt.format(0, 'minute');
  if (Math.abs(minutes) < 60) return fmt.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return fmt.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return fmt.format(-days, 'day');
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return fmt.format(-months, 'month');
  return fmt.format(-Math.round(months / 12), 'year');
}
