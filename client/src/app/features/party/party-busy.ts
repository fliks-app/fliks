import type { WritableSignal } from '@angular/core';

/** Runs a host call with `busy` raised; null when it failed (the error interceptor already toasted it). */
export async function runBusy<T>(busy: WritableSignal<boolean>, action: () => Promise<T>): Promise<T | null> {
  busy.set(true);
  try {
    return await action();
  } catch {
    return null;
  } finally {
    busy.set(false);
  }
}
