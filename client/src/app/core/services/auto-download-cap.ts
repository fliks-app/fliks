/** True once the finished auto downloads fill `capGb` gigabytes; 0 means no cap. Manual downloads never count. */
export function autoCapReached(tasks: { auto?: boolean; sizeBytes?: number }[], capGb: number): boolean {
  if (capGb <= 0) return false;
  const used = tasks.reduce((sum, t) => (t.auto ? sum + (t.sizeBytes ?? 0) : sum), 0);
  return used >= capGb * 1024 ** 3;
}
