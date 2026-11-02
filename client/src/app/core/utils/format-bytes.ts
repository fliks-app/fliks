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
  return `${val.toFixed(1)} ${units[i]}`;
}
