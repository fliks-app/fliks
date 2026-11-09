import { Observable } from 'rxjs';

export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

/** The first value of `source`; aborting `signal` unsubscribes, which cancels the XHR, and rejects with an AbortError. */
export function abortable<T>(source: Observable<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => new DOMException('aborted', 'AbortError');
    if (signal?.aborted) return reject(aborted());
    const sub = source.subscribe({
      next: (v) => {
        resolve(v);
        sub.unsubscribe();
      },
      error: reject,
      complete: () => reject(new Error('no value')),
    });
    signal?.addEventListener(
      'abort',
      () => {
        sub.unsubscribe();
        reject(aborted());
      },
      { once: true },
    );
  });
}
