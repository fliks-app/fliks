import { signal } from '@angular/core';

/** A server-paged list behind a "show more" button; a reload or a newer request drops the answer of an older one. */
export class PagedList<T> {
  readonly rows = signal<T[]>([]);
  readonly loading = signal(false);
  readonly more = signal(false);
  private generation = 0;

  constructor(
    private readonly fetch: (page: number) => Promise<T[]>,
    private readonly pageSize: number,
  ) {}

  loadMore(): Promise<void> {
    return this.load(true);
  }

  async load(append = false): Promise<void> {
    const gen = ++this.generation;
    this.loading.set(true);
    try {
      const got = await this.fetch(append ? Math.floor(this.rows().length / this.pageSize) + 1 : 1);
      if (gen !== this.generation) return;
      this.rows.set(append ? [...this.rows(), ...got] : got);
      this.more.set(got.length === this.pageSize);
    } catch {
      if (gen === this.generation && !append) this.rows.set([]);
    } finally {
      if (gen === this.generation) this.loading.set(false);
    }
  }
}
