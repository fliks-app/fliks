import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  inject,
  input,
  linkedSignal,
  output,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { BottomSheetComponent } from '../../shared/components/bottom-sheet';
import type { ComicPageSize } from '../../core/services/api/comics.models';
import { ControlsVisibilityService } from '../player/controls/controls-visibility';
import { ReaderBottomBarComponent } from './chrome/reader-bottom-bar';
import { ReaderTopBarComponent } from './chrome/reader-top-bar';
import { ComicEngineComponent } from './engines/comic/comic-engine';
import { EpubEngineComponent } from './engines/epub/epub-engine';
import { PdfEngineComponent } from './engines/pdf/pdf-engine';
import type { ReaderTarget } from './reader-api.service';
import { ReaderAppearanceComponent } from './reader-appearance';
import type { ReaderFormat } from './reader-features';
import { ReaderProgressService } from './reader-progress.service';
import { ReaderSession, type ReaderBookInfo, type ReaderPanel } from './reader-session';
import { ReaderSettingsService } from './reader-settings.service';
import { ReaderSidebarComponent } from './reader-sidebar';

/** The one reader: the bars, the panels and the keys around the engine of the book's format. */
@Component({
  selector: 'app-reader',
  imports: [
    NgTemplateOutlet,
    TranslatePipe,
    BottomSheetComponent,
    ReaderTopBarComponent,
    ReaderBottomBarComponent,
    ReaderSidebarComponent,
    ReaderAppearanceComponent,
    EpubEngineComponent,
    PdfEngineComponent,
    ComicEngineComponent,
  ],
  templateUrl: './reader.html',
  styleUrl: './reader.css',
  encapsulation: ViewEncapsulation.None,
  providers: [ReaderSession, ReaderSettingsService, ReaderProgressService, ControlsVisibilityService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:keydown)': 's.onKeydown($event)',
    '(window:pagehide)': 's.flushProgress()',
    '(document:visibilitychange)': 's.flushProgress()',
    '(document:fullscreenchange)': 's.onFullscreenChange()',
    '(mousemove)': 's.onPointerMove()',
    '(focusin)': 's.onFocusMove()',
    '(focusout)': 's.onFocusMove()',
  },
})
export class ReaderComponent {
  readonly format = input.required<ReaderFormat>();
  readonly target = input.required<ReaderTarget>();
  readonly title = input('');
  readonly info = input<ReaderBookInfo | null>(null);
  /** The page sizes of a comic, read as images. */
  readonly pages = input<ComicPageSize[]>([]);
  readonly closed = output<void>();

  protected readonly s = inject(ReaderSession);
  protected readonly settingsStore = inject(ReaderSettingsService);
  private readonly sidebar = viewChild(ReaderSidebarComponent);
  /** The sheet keeps showing the panel it held while it slides away. */
  protected readonly sheetPanel = linkedSignal<ReaderPanel | null, ReaderPanel | null>({
    source: this.s.panel,
    computation: (p, prev) => p ?? prev?.value ?? null,
  });

  constructor() {
    this.s.connect({
      format: this.format,
      title: this.title,
      target: this.target,
      info: this.info,
      close: () => this.closed.emit(),
    });
    this.s.beforePanelClose = () => this.sidebar()?.flushNote();
  }
}
