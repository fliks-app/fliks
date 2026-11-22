import { Injectable, signal } from '@angular/core';

const KEY = 'fliks-recent-searches';
const MAX = 5;

/** The last committed queries, newest first, kept per browser. */
@Injectable({ providedIn: 'root' })
export class RecentSearchesService {
  readonly terms = signal<string[]>(this.read());

  add(query: string): void {
    const q = query.trim();
    if (!q) return;
    this.write([q, ...this.terms().filter((t) => t.toLowerCase() !== q.toLowerCase())].slice(0, MAX));
  }

  clear(): void {
    this.write([]);
  }

  private write(terms: string[]): void {
    this.terms.set(terms);
    try {
      localStorage.setItem(KEY, JSON.stringify(terms));
    } catch {
      /* storage unavailable: the list lasts for the session */
    }
  }

  private read(): string[] {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').slice(0, MAX) : [];
    } catch {
      return [];
    }
  }
}
