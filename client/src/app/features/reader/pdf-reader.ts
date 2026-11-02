import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideArrowLeft, LucideZoomIn, LucideZoomOut } from '@lucide/angular';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { AuthService } from '../../core/services/auth.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { ToastService } from '../../core/services/toast.service';
import { pdfPageOf, pdfProgression } from './pdf-position';
import { ReaderApiService, type ReaderTarget } from './reader-api.service';
import { ReaderProgressService } from './reader-progress.service';
import {
  READER_THEMES,
  ReaderSettingsService,
  ZOOM_RANGE,
  readerThemeColors,
  type ReaderTheme,
} from './reader-settings.service';

/** Pages around the viewport that are drawn; the others hold only their size. */
const RENDER_MARGIN = '150% 0px';
const MAX_FIT_WIDTH = 1100;

/** The PDF of a book, one canvas per page in a scroller; pdf.js and its worker load on first open. */
@Component({
  selector: 'app-pdf-reader',
  imports: [TranslatePipe, LucideArrowLeft, LucideZoomIn, LucideZoomOut],
  templateUrl: './pdf-reader.html',
  styleUrl: './pdf-reader.css',
  encapsulation: ViewEncapsulation.None,
  providers: [ReaderSettingsService, ReaderProgressService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:keydown)': 'onKeydown($event)',
    '(window:pagehide)': 'flushProgress()',
    '(document:visibilitychange)': 'flushProgress()',
  },
})
export class PdfReaderComponent implements OnDestroy {
  readonly target = input.required<ReaderTarget>();
  readonly title = input('');
  readonly closed = output<void>();

  private readonly api = inject(ReaderApiService);
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly settingsStore = inject(ReaderSettingsService);
  private readonly progress = inject(ReaderProgressService);
  private readonly injector = inject(Injector);
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');

  private doc: PDFDocumentProxy | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private observer: IntersectionObserver | null = null;
  private resizer: ResizeObserver | null = null;
  private readonly tasks = new Map<number, RenderTask>();
  private destroyed = false;
  private raf = 0;

  protected readonly settings = this.settingsStore.settings;
  protected readonly colors = computed(() => readerThemeColors(this.settings().theme));
  protected readonly zoomRange = ZOOM_RANGE;
  protected readonly themes = READER_THEMES;
  protected readonly loading = signal(true);
  protected readonly pages = signal<number[]>([]);
  protected readonly page = signal(1);
  protected readonly ratio = signal(1.414);
  protected readonly viewportWidth = signal(0);
  protected readonly pageWidth = computed(() =>
    Math.round(Math.min(this.viewportWidth(), MAX_FIT_WIDTH) * this.settings().zoom),
  );
  /** The page named by the slider while it is dragged, before the jump. */
  protected readonly scrubbing = signal<number | null>(null);
  protected readonly shownPage = computed(() => this.scrubbing() ?? this.page());

  constructor() {
    afterNextRender(() => void this.open());
    effect(() => {
      this.pageWidth();
      this.pages();
      untracked(() => afterNextRender(() => this.reobserve(), { injector: this.injector }));
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    this.resizer?.disconnect();
    this.tasks.forEach((t) => t.cancel());
    void this.progress.flush();
    void this.loadingTask?.destroy();
  }

  private async open(): Promise<void> {
    try {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', document.baseURI).href;
      const target = this.target();
      const token = this.auth.accessToken;
      const task = pdfjs.getDocument({
        url: new URL(this.serverConfig.resolveUrl(`/api/stream/${target.fileId}`), document.baseURI).href,
        httpHeaders: this.serverConfig.isNative && token ? { Authorization: `Bearer ${token}` } : undefined,
        useWasm: false,
        enableXfa: false,
      });
      this.loadingTask = task;
      const [doc, saved] = await Promise.all([task.promise, this.api.loadProgress(target)]);
      if (this.destroyed) return void task.destroy();
      this.doc = doc;
      const v = (await doc.getPage(1)).getViewport({ scale: 1 });
      this.ratio.set(v.height / v.width);
      const root = this.scroller().nativeElement;
      this.viewportWidth.set(root.clientWidth);
      this.resizer = new ResizeObserver(() => this.viewportWidth.set(root.clientWidth));
      this.resizer.observe(root);
      this.observer = new IntersectionObserver(
        (entries) =>
          entries.forEach((e) => e.isIntersecting && void this.render(Number((e.target as HTMLElement).dataset['page']))),
        { root, rootMargin: RENDER_MARGIN },
      );
      const resumeAt = pdfPageOf(saved?.locator, doc.numPages);
      this.page.set(resumeAt);
      this.pages.set(Array.from({ length: doc.numPages }, (_, i) => i + 1));
      this.loading.set(false);
      afterNextRender(() => this.scrollToPage(resumeAt), { injector: this.injector });
    } catch {
      if (this.destroyed) return;
      this.toast.error(this.translate.instant('reader.open_failed'));
      this.closed.emit();
    }
  }

  /** Observing again reports every slot, so a size change redraws the ones in view. */
  private reobserve(): void {
    if (!this.observer) return;
    this.observer.disconnect();
    this.scroller().nativeElement.querySelectorAll('[data-page]').forEach((el) => this.observer?.observe(el));
  }

  private async render(n: number): Promise<void> {
    const slot = this.scroller().nativeElement.querySelector<HTMLElement>(`[data-page="${n}"]`);
    const css = this.pageWidth();
    if (!slot || !this.doc || slot.dataset['drawn'] === String(css)) return;
    this.tasks.get(n)?.cancel();
    try {
      const page = await this.doc.getPage(n);
      const unit = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (css / unit.width) * (window.devicePixelRatio || 1) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const task = page.render({ canvas, viewport });
      this.tasks.set(n, task);
      await task.promise;
      if (this.destroyed) return;
      slot.style.aspectRatio = `${unit.width} / ${unit.height}`;
      slot.dataset['drawn'] = String(css);
      slot.replaceChildren(canvas);
    } catch {
      // A draw cancelled by a zoom change, or a page that does not draw, leaves its blank slot.
    }
  }

  protected onScroll(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      const root = this.scroller().nativeElement;
      const probe = root.getBoundingClientRect().top + root.clientHeight / 3;
      const slots = Array.from(root.querySelectorAll<HTMLElement>('[data-page]'));
      const hit = slots.filter((s) => s.getBoundingClientRect().top <= probe).pop() ?? slots[0];
      const n = Number(hit?.dataset['page'] ?? 1);
      if (n === this.page()) return;
      this.page.set(n);
      this.progress.report(this.target(), {
        progression: pdfProgression(n, this.pages().length),
        locator: { page: n },
      });
    });
  }

  private scrollToPage(n: number): void {
    this.scroller().nativeElement.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: 'start' });
  }

  protected zoom(delta: number): void {
    const n = this.page();
    this.settingsStore.save({ zoom: this.settings().zoom + delta });
    afterNextRender(() => this.scrollToPage(n), { injector: this.injector });
  }

  protected setTheme(theme: ReaderTheme): void {
    this.settingsStore.save({ theme });
  }

  protected onScrub(e: Event): void {
    this.scrubbing.set(Number((e.target as HTMLInputElement).value));
  }

  protected onSeek(e: Event): void {
    this.scrubbing.set(null);
    this.scrollToPage(Number((e.target as HTMLInputElement).value));
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.altKey || e.metaKey || (e.target as HTMLElement | null)?.closest('input, select, textarea')) return;
    const root = this.scroller().nativeElement;
    const last = this.pages().length;
    const keys: Record<string, () => void> = {
      Escape: () => this.closed.emit(),
      Home: () => this.scrollToPage(1),
      End: () => this.scrollToPage(last),
      '+': () => this.zoom(ZOOM_RANGE.step),
      '=': () => this.zoom(ZOOM_RANGE.step),
      '-': () => this.zoom(-ZOOM_RANGE.step),
      ArrowRight: () => this.scrollToPage(Math.min(last, this.page() + 1)),
      ArrowLeft: () => this.scrollToPage(Math.max(1, this.page() - 1)),
      PageDown: () => root.scrollBy({ top: root.clientHeight * 0.9 }),
      PageUp: () => root.scrollBy({ top: -root.clientHeight * 0.9 }),
      ' ': () => root.scrollBy({ top: root.clientHeight * 0.9 * (e.shiftKey ? -1 : 1) }),
    };
    const act = keys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  }

  protected flushProgress(): void {
    void this.progress.flush();
  }
}
