import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { BooksApiService } from '../../../core/services/api/books-api.service';
import type { BookDetail } from '../../../core/services/api/books.models';

const DEBOUNCE_MS = 250;

/** Puts a book in a series by hand, or takes it out; the author's series are suggested first. */
@Component({
  selector: 'app-book-series-form',
  imports: [TranslatePipe],
  templateUrl: './book-series-form.component.html',
  host: { class: 'block' },
})
export class BookSeriesFormComponent {
  readonly mediaId = input.required<number>();
  readonly series = input<BookDetail['series'][number] | null>(null);
  readonly authorIds = input<number[]>([]);
  /** The series is a hand choice the providers no longer overwrite. */
  readonly locked = input(false);
  readonly done = output<void>();

  private readonly api = inject(BooksApiService);
  protected readonly name = signal('');
  protected readonly position = signal('');
  protected readonly busy = signal(false);
  private readonly ofAuthors = signal<{ id: number; name: string }[]>([]);
  private readonly found = signal<{ id: number; name: string }[]>([]);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;

  private readonly known = computed(() => [...this.ofAuthors(), ...this.found()]);
  protected readonly suggestions = computed(() => [...new Set(this.known().map((s) => s.name))]);
  protected readonly canSave = computed(() => !this.busy() && !!this.name().trim());

  constructor() {
    effect(() => {
      const s = this.series();
      untracked(() => {
        this.name.set(s?.name ?? '');
        this.position.set(s?.positionLabel ?? (s?.position != null ? String(s.position) : ''));
      });
    });
    effect(() => {
      const ids = this.authorIds();
      untracked(() => void this.loadAuthorSeries(ids));
    });
  }

  protected typed(value: string): void {
    this.name.set(value);
    clearTimeout(this.timer);
    this.abort?.abort();
    this.timer = setTimeout(() => void this.search(value.trim()), DEBOUNCE_MS);
  }

  protected save(): Promise<void> {
    const name = this.name().trim();
    const picked = this.known().find((s) => s.name.toLowerCase() === name.toLowerCase());
    return this.run(() => this.api.putSeries(this.mediaId(), { ...(picked && { id: picked.id }), name, position: this.position().trim() || null }));
  }

  protected remove(): Promise<void> {
    return this.run(() => this.api.deleteSeries(this.mediaId()));
  }

  protected reset(): Promise<void> {
    return this.run(() => this.api.resetSeries(this.mediaId()));
  }

  private async run(call: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    try {
      await call();
      this.done.emit();
    } catch {
      /* the global interceptor toasts the failure */
    } finally {
      this.busy.set(false);
    }
  }

  private async loadAuthorSeries(ids: number[]): Promise<void> {
    const all = await Promise.all(ids.map((id) => this.api.personWorks(id, 'author', true).then((w) => w.series.map((s) => s.collection), () => [])));
    this.ofAuthors.set(all.flat());
  }

  private async search(q: string): Promise<void> {
    if (q.length < 2) return this.found.set([]);
    this.abort = new AbortController();
    const { signal } = this.abort;
    const rows = await this.api.collections({ kind: 'book', q, limit: 10 }, signal, true).then((r) => r.map((c) => ({ id: c.id, name: c.name })), () => null);
    if (rows && !signal.aborted) this.found.set(rows);
  }
}
