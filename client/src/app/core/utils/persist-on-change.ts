import { effect, untracked } from '@angular/core';

/** Persist a settings form on every change (no save button); needs an injection context. `read` must touch only form signals;
 *  `write` runs untracked so it can merge store fields without re-triggering. The first run is skipped: it only mirrors what was just read. */
export function persistOnChange<T>(read: () => T, write: (value: T) => void): void {
  let loaded = false;
  effect(() => {
    const value = read();
    if (!loaded) {
      loaded = true;
      return;
    }
    untracked(() => write(value));
  });
}
