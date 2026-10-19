/** Merges a stored order with the available set: saved positions kept, new items appended in `defaults` order, vanished ones dropped. */
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
