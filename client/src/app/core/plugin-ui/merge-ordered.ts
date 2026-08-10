/**
 * Merge a stored user order with the currently-available set: items still
 * available keep their saved position, items never seen before are appended
 * in their canonical (`defaults`) order, and items that disappeared are
 * dropped silently. Lifted out of `HomeSettingsService.resolve()` so a
 * second consumer (the plugin nav order) doesn't reimplement it.
 */
export function mergeOrdered<T>(
  saved: T[],
  defaults: T[],
  available: ReadonlySet<string>,
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of saved) {
    const key = keyOf(item);
    if (available.has(key) && !seen.has(key)) {
      merged.push(item);
      seen.add(key);
    }
  }
  for (const item of defaults) {
    const key = keyOf(item);
    if (available.has(key) && !seen.has(key)) {
      merged.push(item);
      seen.add(key);
    }
  }
  return merged;
}
