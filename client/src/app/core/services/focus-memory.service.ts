import { Injectable } from '@angular/core';

/** Per-route memory of the last focused element so back-navigation lands on the card just left; ids are CSS selectors under an opaque page key, both owned by components. */
@Injectable({ providedIn: 'root' })
export class FocusMemoryService {
  /** `nth` tells apart items sharing an id (the same title in two rows). */
  private readonly memory = new Map<string, { id: string; nth: number }>();

  save(pageKey: string, id: string, nth = 0) {
    this.memory.set(pageKey, { id, nth });
  }

  retrieve(pageKey: string): { id: string; nth: number } | null {
    return this.memory.get(pageKey) ?? null;
  }

  clear(pageKey: string) {
    this.memory.delete(pageKey);
  }
}
