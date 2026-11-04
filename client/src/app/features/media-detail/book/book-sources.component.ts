import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PluginUiRegistryService } from '../../../core/plugin-ui/plugin-ui-registry.service';
import { BooksApiService } from '../../../core/services/api/books-api.service';
import type { BookEdition, BookSources } from '../../../core/services/api/books.models';
import { editionLabel } from '../../../core/services/api/book-media';

const STANDARD_IDS = ['isbn', 'asin'];

/** Where the editions are linked at the providers: link, relink or unlink an identifier. The work is identified by the shared identify modal. */
@Component({
  selector: 'app-book-sources',
  imports: [TranslatePipe],
  templateUrl: './book-sources.component.html',
  host: { class: 'block' },
})
export class BookSourcesComponent {
  readonly mediaId = input.required<number>();
  readonly editions = input.required<BookEdition[]>();

  private readonly api = inject(BooksApiService);
  private readonly registry = inject(PluginUiRegistryService);
  protected readonly sources = signal<BookSources | null>(null);
  protected readonly busy = signal(false);

  protected readonly editionId = signal<number | null>(null);
  protected readonly provider = signal(STANDARD_IDS[0]);
  protected readonly value = signal('');

  /** Identifier standards, then the namespaces of the installed book providers. */
  protected readonly providers = computed(() => [
    ...STANDARD_IDS,
    ...this.registry
      .pluginEntries()
      .filter((e) => e.provider?.kinds.includes('book'))
      .flatMap((e) => e.provider!.namespaces)
      .filter((n) => !STANDARD_IDS.includes(n)),
  ]);
  protected readonly canSave = computed(() => !this.busy() && this.editionId() != null && !!this.value().trim());
  protected readonly label = editionLabel;

  constructor() {
    effect(() => {
      const id = this.mediaId();
      untracked(() => void this.load(id));
    });
    effect(() => {
      const first = this.editions()[0]?.id ?? null;
      untracked(() => {
        if (this.editionId() == null) this.editionId.set(first);
      });
    });
  }

  protected editionOf(id: number): BookEdition | undefined {
    return this.editions().find((e) => e.id === id);
  }

  /** Loads a linked identifier into the form; saving it replaces the one at that provider. */
  protected relink(editionId: number, provider: string, value: string): void {
    this.editionId.set(editionId);
    this.provider.set(provider);
    this.value.set(value);
  }

  protected async save(): Promise<void> {
    const editionId = this.editionId();
    if (editionId == null) return;
    const ok = await this.run(() =>
      this.api.putSource(this.mediaId(), {
        level: 'edition',
        editionId,
        provider: this.provider(),
        value: this.value().trim(),
      }),
    );
    if (ok) this.value.set('');
  }

  protected unlink(editionId: number, provider: string, value: string): Promise<boolean> {
    return this.run(() =>
      this.api.deleteSource(this.mediaId(), { level: 'edition', editionId, provider, value }),
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
