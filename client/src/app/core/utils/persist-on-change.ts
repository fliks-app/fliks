import { effect, untracked } from '@angular/core';

/**
 * Persist a settings form on every change: the pages carry no save button.
 * Call from an injection context (field initializer or constructor).
 *
 * `read` must touch the form signals only. `write` runs untracked, so it can
 * read the store to merge fields another page owns without the resulting
 * store update re-triggering this effect.
 *
 * The first run is skipped: it only mirrors the values just read from the
 * store, and writing them back could clobber a field changed elsewhere since.
 */
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
