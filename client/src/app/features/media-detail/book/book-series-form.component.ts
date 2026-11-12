import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';
import { BooksApiService } from '../../../core/services/api/books-api.service';
import type { BookDetail } from '../../../core/services/api/books.models';

const NEW = 'new';

/** Puts a book in a series of its authors by hand, or in a new one, or takes it out. */
@Component({
  selector: 'app-book-series-form',
  imports: [TranslatePipe, SelectFieldComponent],
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
  protected readonly NEW = NEW;
  protected readonly name = signal('');
  protected readonly choice = signal(NEW);
  protected readonly position = signal('');
  protected readonly busy = signal(false);
  private readonly ofAuthors = signal<{ id: number; name: string }[]>([]);
  private readonly allSeries = signal<{ id: number; name: string }[]>([]);

  protected readonly options = computed(() => {
    const current = this.series();
    const others = [...this.allSeries()].sort((a, b) => a.name.localeCompare(b.name));
    const all = [...(current ? [{ id: current.id, name: current.name }] : []), ...this.ofAuthors(), ...others];
    return [...new Map(all.map((s) => [s.id, s])).values()];
  });
  protected readonly isNew = computed(() => this.options().length === 0 || this.choice() === NEW);
  protected readonly canSave = computed(() => !this.busy() && (!this.isNew() || !!this.name().trim()));

  constructor() {
    effect(() => {
      const s = this.series();
      untracked(() => {
        this.name.set('');
        this.choice.set(s ? String(s.id) : NEW);
        this.position.set(s?.positionLabel ?? (s?.position != null ? String(s.position) : ''));
      });
    });
    void this.loadAllSeries();
    effect(() => {
      const ids = this.authorIds();
      untracked(() => void this.loadAuthorSeries(ids));
    });
  }

  protected save(): Promise<void> {
    const position = this.position().trim() || null;
    const target = this.isNew() ? { name: this.name().trim() } : { id: Number(this.choice()) };
    return this.run(() => this.api.putSeries(this.mediaId(), { ...target, position }));
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

  private async loadAllSeries(): Promise<void> {
    const all = await this.api.collections({ kind: 'book' }, undefined, true).catch(() => []);
    this.allSeries.set(all.map((c) => ({ id: c.id, name: c.name })));
  }

  private async loadAuthorSeries(ids: number[]): Promise<void> {
    const all = await Promise.all(ids.map((id) => this.api.personWorks(id, 'author', true).then((w) => w.series.map((s) => s.collection), () => [])));
    this.ofAuthors.set(all.flat());
  }
}
