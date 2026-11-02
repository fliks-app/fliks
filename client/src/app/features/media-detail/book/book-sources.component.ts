import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { BooksApiService } from '../../../core/services/api/books-api.service';
import type { BookEdition, BookSources } from '../../../core/services/api/books.models';
import { CollapsibleSectionComponent } from '../../../shared/components/collapsible-section/collapsible-section';
import { editionLabel } from './book-media';

type Level = 'work' | 'edition';

const WORK_PROVIDERS = ['openlibrary'];
const EDITION_PROVIDERS = ['isbn', 'asin', 'openlibrary', 'googlebooks', 'bnf'];

/** Where the work and its editions are linked at the providers: link, relink or unlink an identifier. */
@Component({
  selector: 'app-book-sources',
  imports: [TranslatePipe, CollapsibleSectionComponent],
  templateUrl: './book-sources.component.html',
  host: { class: 'block' },
})
export class BookSourcesComponent {
  readonly mediaId = input.required<number>();
  readonly editions = input.required<BookEdition[]>();

  private readonly api = inject(BooksApiService);
  protected readonly sources = signal<BookSources | null>(null);
  protected readonly busy = signal(false);

  protected readonly level = signal<Level>('work');
  protected readonly editionId = signal<number | null>(null);
  protected readonly provider = signal(WORK_PROVIDERS[0]);
  protected readonly value = signal('');

  protected readonly providers = computed(() => (this.level() === 'work' ? WORK_PROVIDERS : EDITION_PROVIDERS));
  protected readonly canSave = computed(() => !this.busy() && !!this.value().trim());
  protected readonly label = editionLabel;

  constructor() {
    effect(() => {
      const id = this.mediaId();
      untracked(() => void this.load(id));
    });
  }

  protected editionOf(id: number): BookEdition | undefined {
    return this.editions().find((e) => e.id === id);
  }

  protected setLevel(level: Level): void {
    this.level.set(level);
    this.editionId.set(level === 'edition' ? (this.editions()[0]?.id ?? null) : null);
    this.provider.set(this.providers()[0]);
  }

  /** Loads a linked identifier into the form; saving it replaces the one at that provider. */
  protected relink(level: Level, editionId: number | null, provider: string, value: string): void {
    this.level.set(level);
    this.editionId.set(editionId);
    this.provider.set(provider);
    this.value.set(value);
  }

  protected async save(): Promise<void> {
    const level = this.level();
    const editionId = this.editionId();
    if (level === 'edition' && editionId == null) return;
    const ok = await this.run(() =>
      this.api.putSource(this.mediaId(), {
        level,
        editionId: level === 'edition' ? (editionId ?? undefined) : undefined,
        provider: this.provider(),
        value: this.value().trim(),
      }),
    );
    if (ok) this.value.set('');
  }

  protected unlink(level: Level, editionId: number | null, provider: string, value: string): Promise<boolean> {
    return this.run(() =>
      this.api.deleteSource(this.mediaId(), { level, editionId: editionId ?? undefined, provider, value }),
    );
  }

  private async run(call: () => Promise<BookSources>): Promise<boolean> {
    this.busy.set(true);
    try {
      this.sources.set(await call());
      return true;
    } catch {
      /* the global interceptor toasts the failure */
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private async load(id: number): Promise<void> {
    try {
      const s = await this.api.sources(id);
      if (this.mediaId() === id) this.sources.set(s);
    } catch {
      if (this.mediaId() === id) this.sources.set(null);
    }
  }
}
