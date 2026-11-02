import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { BooksApiService } from '../../../core/services/api/books-api.service';
import type { BookChapter, BookEdition } from '../../../core/services/api/books.models';
import { CollapsibleSectionComponent } from '../../../shared/components/collapsible-section/collapsible-section';
import { editionLabel, formatClock } from './book-media';

/** Chapters of one of the audio editions that has a file; hidden when the edition has none. */
@Component({
  selector: 'app-book-chapters',
  imports: [TranslatePipe, CollapsibleSectionComponent],
  templateUrl: './book-chapters.component.html',
  host: { class: 'block' },
})
export class BookChaptersComponent {
  readonly mediaId = input.required<number>();
  readonly editions = input.required<BookEdition[]>();

  private readonly api = inject(BooksApiService);
  private readonly picked = signal<number | null>(null);
  protected readonly chapters = signal<BookChapter[]>([]);

  protected readonly audio = computed(() => this.editions().filter((e) => e.family === 'audio' && e.hasFile));
  protected readonly editionId = computed(() => {
    const audio = this.audio();
    return audio.find((e) => e.id === this.picked())?.id ?? audio[0]?.id ?? null;
  });

  protected readonly clock = formatClock;
  protected readonly label = editionLabel;

  constructor() {
    effect(() => {
      const mediaId = this.mediaId();
      const editionId = this.editionId();
      untracked(() => void this.load(mediaId, editionId));
    });
  }

  protected pick(e: Event): void {
    this.picked.set(Number((e.target as HTMLSelectElement).value));
  }

  private async load(mediaId: number, editionId: number | null): Promise<void> {
    if (editionId == null) {
      this.chapters.set([]);
      return;
    }
    try {
      const chapters = await this.api.chapters(mediaId, editionId);
      if (this.editionId() === editionId) this.chapters.set(chapters);
    } catch {
      if (this.editionId() === editionId) this.chapters.set([]);
    }
  }
}
