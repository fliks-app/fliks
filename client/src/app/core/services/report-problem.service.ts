import { Injectable, signal } from '@angular/core';
import type { ProblemKind } from './api/problems.service';

/** What the report dialog opens on; `locked` fixes the scope and kind (the player overlay). */
export interface ReportProblemTarget {
  mediaId: number;
  title: string;
  /** An episode, a track or a book edition: the report is about this item. */
  itemId?: number;
  seasonNumber?: number;
  /** Label of the scope (`S02E03`, a season, a track), shown under the title. */
  scopeLabel?: string;
  mediaFileId?: number;
  kind?: ProblemKind;
  locked?: boolean;
}

/** App-wide broker for the report-a-problem dialog; the layout hosts it behind a `@defer`. */
@Injectable({ providedIn: 'root' })
export class ReportProblemService {
  private counter = 0;
  readonly request = signal<{ target: ReportProblemTarget; n: number } | null>(null);

  open(target: ReportProblemTarget): void {
    this.request.set({ target, n: ++this.counter });
  }

  clear(): void {
    this.request.set(null);
  }
}
