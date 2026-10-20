import { Injectable } from '@angular/core';

/** Per-route memory of the last focused element so back-navigation lands on the card just left; ids are CSS selectors under an opaque page key, both owned by components. */
@Injectable({ providedIn: 'root' })
export class FocusMemoryService {
  private readonly memory = new Map<string, string>();

  save(pageKey: string, selector: string) {
    this.memory.set(pageKey, selector);
  }

  retrieve(pageKey: string): string | null {
    return this.memory.get(pageKey) ?? null;
  }

  clear(pageKey: string) {
    this.memory.delete(pageKey);
  }
}
