import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { BooksApiService } from '../../../core/services/api/books-api.service';
import type { BookDetail } from '../../../core/services/api/books.models';

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
  readonly done = output<void>();

  private readonly api = inject(BooksApiService);
  protected readonly name = signal('');
  protected readonly position = signal('');
  protected readonly busy = signal(false);
  private readonly ofAuthors = signal<string[]>([]);
  private readonly found = signal<string[]>([]);
  private lookup = 0;

  protected readonly suggestions = computed(() => [...new Set([...this.ofAuthors(), ...this.found()])]);
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
    void this.search(value.trim());
  }

  protected save(): Promise<void> {
    return this.run(() => this.api.putSeries(this.mediaId(), { name: this.name().trim(), position: this.position().trim() || null }));
  }

  protected remove(): Promise<void> {
    return this.run(() => this.api.deleteSeries(this.mediaId()));
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
    const all = await Promise.all(ids.map((id) => this.api.personWorks(id, 'author').then((w) => w.series.map((s) => s.collection.name), () => [])));
    this.ofAuthors.set(all.flat());
  }

  private async search(q: string): Promise<void> {
    const call = ++this.lookup;
    const rows = q.length < 2 ? [] : await this.api.collections({ kind: 'book', q, limit: 10 }).then((r) => r.map((c) => c.name), () => []);
    if (call === this.lookup) this.found.set(rows);
  }
}
