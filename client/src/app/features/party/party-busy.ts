import { afterNextRender, type Injector, type WritableSignal } from '@angular/core';

/** Runs a host call with `busy` raised; null when it failed (the error interceptor already toasted it) or one is already running. */
export async function runBusy<T>(busy: WritableSignal<boolean>, action: () => Promise<T>): Promise<T | null> {
  if (busy()) return null;
  busy.set(true);
  try {
    return await action();
  } catch {
    return null;
  } finally {
    busy.set(false);
  }
}

/** After the next render, focuses `target` again if a move or re-sort dropped the focus to the page body. */
export function keepFocus(injector: Injector, target: () => HTMLElement | null | undefined): void {
  afterNextRender(
    () => {
      const active = document.activeElement;
      if (!active || active === document.body) target()?.focus();
    },
    { injector },
  );
}
