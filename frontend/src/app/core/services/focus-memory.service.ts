import { Injectable } from '@angular/core';

/**
 * Per-route memory of the last focused element so back-navigation can land
 * on the card the user just left, while a fresh visit lands on the page's
 * default focus. Identifiers are CSS selectors stored against an opaque
 * page key — components own both the key and the selector format.
 */
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
