import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { BooksApiService } from '../../core/services/api/books-api.service';
import type { BookSearchResult, PersonWorks } from '../../core/services/api/books.models';
import { mediaDetailLink } from '../../core/media-kinds';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';

type Work = PersonWorks['standalone'][number];

/** Owned works of an author or narrator (by series, then standalone) and the provider bibliography. */
@Component({
  selector: 'app-person-books',
  imports: [TranslatePipe, RouterLink, MediaCardComponent],
  templateUrl: './person-books.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonBooksComponent {
  private readonly api = inject(BooksApiService);

  readonly personId = input.required<number>();
  readonly role = input.required<'author' | 'narrator'>();

  readonly works = signal<PersonWorks | null>(null);
  readonly credits = signal<BookSearchResult[]>([]);
  readonly loading = signal(true);

  /** Credits not yet in a readable library; the owned ones already show above. */
  readonly missing = computed(() => this.credits().filter((c) => c.mediaId === null));

  constructor() {
    effect(() => void this.load(this.personId(), this.role()));
  }

  link(m: Work) {
    return mediaDetailLink(m.type, m.id);
  }

  /** The provider bibliography is best effort: a person without a provider id has none. */
  private async load(id: number, role: 'author' | 'narrator') {
    this.loading.set(true);
    try {
      const [works, credits] = await Promise.all([
        this.api.personWorks(id, role),
        this.api.personProviderCredits(id).catch(() => []),
      ]);
      this.works.set(works);
      this.credits.set(credits);
    } finally {
      this.loading.set(false);
    }
  }
}
