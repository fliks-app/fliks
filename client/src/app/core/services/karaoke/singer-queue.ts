/** A song a singer put forward, e.g. a party proposal with its proposer. */
export interface QueueEntry {
  id: number;
  singerId: number;
}

/**
 * Round-robin: every singer's n-th song plays before anyone's (n+1)-th. Inside a round the singer
 * who sang least recently goes first (`lastSung`: singer id to the time of their last song), then
 * the one whose song was put forward first. Stable for a fixed input.
 */
export function orderQueue<T extends QueueEntry>(entries: readonly T[], lastSung: ReadonlyMap<number, number> = new Map()): T[] {
  const rank = new Map<number, number>();
  const first = new Map<number, number>();
  const ranked = entries.map((e, i) => {
    const r = rank.get(e.singerId) ?? 0;
    rank.set(e.singerId, r + 1);
    if (!first.has(e.singerId)) first.set(e.singerId, i);
    return { e, r, i };
  });
  return ranked
    .sort(
      (a, b) =>
        a.r - b.r ||
        (lastSung.get(a.e.singerId) ?? -Infinity) - (lastSung.get(b.e.singerId) ?? -Infinity) ||
        first.get(a.e.singerId)! - first.get(b.e.singerId)! ||
        a.i - b.i,
    )
    .map((x) => x.e);
}
