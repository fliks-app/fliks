/** Numbers follow the UI language (`<html lang>`, kept by ShellLanguageService): "1,5" in French, "1.5" in English. */
export function localized(value: number, digits: number): string {
  const lang = typeof document === 'undefined' ? undefined : document.documentElement.lang || undefined;
  return new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/** Binary size with one decimal; `-` for an unknown (negative) size. */
export function formatBytes(bytes: number): string {
  if (bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${localized(val, i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Decimal bitrate: Mbps with one decimal, kbps whole. */
export function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${localized(bps / 1_000_000, 1)} Mbps`;
  if (bps >= 1_000) return `${localized(bps / 1_000, 0)} kbps`;
  return `${bps} bps`;
}
