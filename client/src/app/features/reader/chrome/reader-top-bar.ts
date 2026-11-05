import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideArrowLeft,
  LucideBookmark,
  LucideHeadphones,
  LucideListTree,
  LucideMaximize,
  LucideMinimize,
  LucideNotebookPen,
  LucideSearch,
  LucideType,
  LucideZoomIn,
  LucideZoomOut,
} from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../../shared/directives/cached-src.directive';
import { ReaderSession } from '../reader-session';

/** The top bar: back, the book, then the actions the format offers. On a phone the bottom bar carries the panels. */
@Component({
  selector: 'app-reader-top-bar',
  imports: [
    TranslatePipe,
    ResolveUrlPipe,
    CachedSrcDirective,
    LucideArrowLeft,
    LucideBookmark,
    LucideHeadphones,
    LucideListTree,
    LucideMaximize,
    LucideMinimize,
    LucideNotebookPen,
    LucideSearch,
    LucideType,
    LucideZoomIn,
    LucideZoomOut,
  ],
  templateUrl: './reader-top-bar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
})
export class ReaderTopBarComponent {
  protected readonly s = inject(ReaderSession);
  protected readonly f = this.s.features;
  protected readonly zoom = computed(() => (this.f().zoom ? this.s.engine()?.zoom : undefined));
  protected readonly bookmarked = computed(() => !!this.s.engine()?.notes?.bookmarked());
  protected readonly sidebarTab = computed(() => (this.s.panel() === 'sidebar' ? this.s.tab() : null));
}
