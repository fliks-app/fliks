/**
 * Run an async map over `items` with at most `limit` operations in flight at
 * any time. Order of `results` matches `items`. Failures bubble up like
 * `Promise.all` (the first rejection cancels remaining work? — see note).
 *
 * Implementation: `limit` workers pull from a shared cursor, so faster items
 * don't block slower ones (better than chunked-batches when ops have
 * variable latency, e.g. image downloads of different sizes).
 *
 * Note: a rejection causes the worker to throw; in-flight peers complete
 * normally but no new items are claimed. If you need full cancellation,
 * wrap `fn` to abort on a shared signal.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
