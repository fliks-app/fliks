import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideHeadphones, LucideListTree, LucideNotebookPen, LucideType } from '@lucide/angular';
import { TranslatePluralPipe } from '../../../core/pipes/translate-plural.pipe';
import { ReaderSession } from '../reader-session';
import { ReaderScrubberComponent } from './reader-scrubber';

/** The bottom bar: the progress bar, where the reader is, and on a phone the panels the top bar leaves out. */
@Component({
  selector: 'app-reader-bottom-bar',
  imports: [
    TranslatePipe,
    TranslatePluralPipe,
    ReaderScrubberComponent,
    LucideHeadphones,
    LucideListTree,
    LucideNotebookPen,
    LucideType,
  ],
  templateUrl: './reader-bottom-bar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
})
export class ReaderBottomBarComponent {
  protected readonly s = inject(ReaderSession);
  protected readonly f = this.s.features;
  protected readonly status = computed(() => this.s.engine()?.status() ?? null);
  protected readonly phoneActions = computed(
    () => this.f().contents || this.f().notes || this.f().appearance.length > 0 || this.s.canListen(),
  );

  protected pagesLeft(left: { pages: number } | { minutes: number }): number | null {
    return 'pages' in left ? left.pages : null;
  }

  protected minutesLeft(left: { pages: number } | { minutes: number }): number {
    return 'minutes' in left ? left.minutes : 0;
  }
}
