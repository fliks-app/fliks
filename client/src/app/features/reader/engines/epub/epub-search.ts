import { Injectable, inject, signal } from '@angular/core';
import { ReaderApiService } from '../../reader-api.service';
import type { ReaderSearch } from '../../reader-engine';
import { SEARCH_MAX_HITS, SEARCH_MIN_CHARS, hitsIn, textOfMarkup, type SearchHit } from '../../reader-search';
import { ReaderSession } from '../../reader-session';
import { EpubBook, parseLocator, pathOf } from './epub-book';

/** Full-text search, chapter by chapter in reading order; a new query or a closed panel stops the run. */
@Injectable()
export class EpubSearch implements ReaderSearch {
  private readonly api = inject(ReaderApiService);
  private readonly book = inject(EpubBook);
  private readonly session = inject(ReaderSession);
  private readonly chapterText = new Map<string, string>();
  private runId = 0;

  readonly hits = signal<SearchHit[]>([]);
  readonly searching = signal(false);
  readonly searched = signal(false);
  readonly text = signal('');

  cancel(): void {
    this.runId++;
    this.searching.set(false);
  }

  /** Opens the search tab on a phrase picked in the text. */
  find(text: string): void {
    this.text.set(text.slice(0, 80));
    this.session.openPanel('sidebar', 'search');
    void this.run(this.text());
  }

  async run(query: string): Promise<void> {
    const pub = this.book.publication;
    const run = ++this.runId;
    this.hits.set([]);
    this.searched.set(false);
    if (!pub || query.trim().length < SEARCH_MIN_CHARS) return;
    this.searching.set(true);
    const found: SearchHit[] = [];
    for (const link of pub.readingOrder.items) {
      if (run !== this.runId || this.book.destroyed || found.length >= SEARCH_MAX_HITS) break;
      try {
        const href = pathOf(link.href);
        let text = this.chapterText.get(href);
        if (text === undefined) {
          text = textOfMarkup(await this.api.markup(this.session.target().itemId, link));
          this.chapterText.set(href, text);
        }
        const chapter = this.book.toc().find((r) => pathOf(r.link.href) === href)?.title ?? '';
        found.push(...hitsIn(link.href, chapter, text, query, SEARCH_MAX_HITS - found.length));
        this.hits.set([...found]);
      } catch {
        // A chapter that cannot be read has no hits.
      }
    }
    if (run !== this.runId) return;
    this.searching.set(false);
    this.searched.set(true);
  }

  go(hit: SearchHit): void {
    this.book.goToPassage(
      parseLocator({
        href: hit.href,
        type: 'application/xhtml+xml',
        locations: { progression: hit.progression },
        text: { before: hit.before, highlight: hit.match, after: hit.after },
      }),
    );
  }
}
