/** Runs work the first paint must not wait on. Safari has no `requestIdleCallback`; the timeout keeps a busy thread from starving it. */
export function whenIdle(run: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(run, { timeout: 2000 });
  else setTimeout(run, 500);
}
