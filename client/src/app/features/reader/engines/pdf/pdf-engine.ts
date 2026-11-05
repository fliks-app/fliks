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
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { AuthService } from '../../../../core/services/auth.service';
import { OfflineBookStoreService } from '../../../../core/services/offline-book-store.service';
import { ServerConfigService } from '../../../../core/services/server-config.service';
import { ToastService } from '../../../../core/services/toast.service';
import { pageAtProbe, scrollToPageSlot } from '../../page-scroll';
import { pageAtProgression, pdfPageOf, pdfProgression } from '../../pdf-position';
import { ReaderApiService, type ReaderTarget } from '../../reader-api.service';
import type { ReaderEngine, ReaderStatus, ReaderZoom, ScrubPreview } from '../../reader-engine';
import type { ReaderKeyAction } from '../../reader-keys';
import { ReaderProgressService } from '../../reader-progress.service';
import { ReaderSession } from '../../reader-session';
import { ReaderSettingsService, ZOOM_RANGE, isDarkTheme } from '../../reader-settings.service';

/** Pages around the viewport that are drawn; the others hold only their size. */
const RENDER_MARGIN = '150% 0px';
const MAX_FIT_WIDTH = 1100;
/** Canvas area cap, under the iOS limit. */
const MAX_CANVAS_PIXELS = 16_000_000;

/** The PDF of a book, one canvas per page in a scroller; pdf.js and its worker load on first open. */
@Component({
  selector: 'app-pdf-engine',
  templateUrl: './pdf-engine.html',
  styleUrl: './pdf-engine.css',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PdfEngineComponent implements ReaderEngine, OnDestroy {
  readonly target = input.required<ReaderTarget>();

  private readonly api = inject(ReaderApiService);
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly settingsStore = inject(ReaderSettingsService);
  private readonly progress = inject(ReaderProgressService);
  private readonly session = inject(ReaderSession);
  private readonly books = inject(OfflineBookStoreService);
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
  readonly loading = signal(true);
  readonly rtl = signal(false);
  protected readonly pages = signal<number[]>([]);
  protected readonly page = signal(1);
  readonly steps = computed(() => this.pages().length);
  readonly progression = computed(() => pdfProgression(this.page(), this.pages().length));
  readonly segments = signal([0]);
  readonly status = computed<ReaderStatus>(() => ({
    section: '',
    sectionLeft: null,
    page: this.page(),
    pages: this.pages().length,
    bookLeft: null,
  }));
  readonly zoom: ReaderZoom = {
    canIn: computed(() => this.settings().zoom < ZOOM_RANGE.max),
    canOut: computed(() => this.settings().zoom > ZOOM_RANGE.min),
    by: (dir) => this.zoomBy(dir * ZOOM_RANGE.step),
  };
  protected readonly ratio = signal(1.414);
  protected readonly viewportWidth = signal(0);
  protected readonly pageWidth = computed(() =>
    Math.round(Math.min(this.viewportWidth(), MAX_FIT_WIDTH) * this.settings().zoom),
  );
  constructor() {
    this.session.attach(this);
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
      const local = target.localKey ? await this.books.fileUrl({ family: 'text' }, target.localKey) : null;
      const task = pdfjs.getDocument({
        url: local ?? new URL(this.serverConfig.resolveUrl(`/api/stream/${target.fileId}`), document.baseURI).href,
        httpHeaders: !local && this.serverConfig.isNative && token ? { Authorization: `Bearer ${token}` } : undefined,
        useWasm: false,
        wasmUrl: new URL('pdfjs/wasm/', document.baseURI).href,
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
          entries.forEach((e) => {
            const n = Number((e.target as HTMLElement).dataset['page']);
            if (e.isIntersecting) void this.render(n);
            else this.release(n, e.target as HTMLElement);
          }),
        { root, rootMargin: RENDER_MARGIN },
      );
      const resumeAt = pdfPageOf(saved?.locator, doc.numPages);
      this.page.set(resumeAt);
      this.pages.set(Array.from({ length: doc.numPages }, (_, i) => i + 1));
      this.loading.set(false);
      afterNextRender(() => this.scrollToPage(resumeAt), { injector: this.injector });
      if (doc.numPages === 1) this.reportPage(1);
    } catch {
      if (this.destroyed) return;
      this.toast.error(this.translate.instant('reader.open_failed'));
      this.session.close();
    }
  }

  /** Observing again reports every slot, so a size change redraws the ones in view. */
  private reobserve(): void {
    if (!this.observer) return;
    this.observer.disconnect();
    this.scroller().nativeElement.querySelectorAll('[data-page]').forEach((el) => this.observer?.observe(el));
  }

  /** Frees the canvas of a page that left the render margin. */
  private release(n: number, slot: HTMLElement): void {
    this.tasks.get(n)?.cancel();
    this.tasks.delete(n);
    slot.replaceChildren();
    delete slot.dataset['drawn'];
  }

  private async render(n: number): Promise<void> {
    const slot = this.scroller().nativeElement.querySelector<HTMLElement>(`[data-page="${n}"]`);
    const css = this.pageWidth();
    if (!slot || !this.doc || slot.dataset['drawn'] === String(css)) return;
    this.tasks.get(n)?.cancel();
    try {
      const page = await this.doc.getPage(n);
      const unit = page.getViewport({ scale: 1 });
      const wanted = (css / unit.width) * (window.devicePixelRatio || 1);
      const cap = Math.sqrt(MAX_CANVAS_PIXELS / (unit.width * unit.height));
      const viewport = page.getViewport({ scale: Math.min(wanted, cap) });
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
      const n = pageAtProbe(this.scroller().nativeElement);
      if (n === this.page()) return;
      this.page.set(n);
      this.reportPage(n);
    });
  }

  private reportPage(n: number): void {
    this.progress.report(this.target(), {
      progression: pdfProgression(n, this.pages().length),
      locator: { page: n },
    });
  }

  private scrollToPage(n: number): void {
    scrollToPageSlot(this.scroller().nativeElement, n);
  }

  private zoomBy(delta: number): void {
    const n = this.page();
    this.settingsStore.save({ zoom: this.settings().zoom + delta });
    afterNextRender(() => this.scrollToPage(n), { injector: this.injector });
  }

  protected isDark(): boolean {
    return isDarkTheme(this.settings().theme);
  }

  /** A tap on the pages shows or hides the bars. */
  protected onTap(): void {
    if (!window.getSelection()?.isCollapsed) return;
    this.session.toggleChrome();
  }

  seek(at: number): void {
    this.scrollToPage(pageAtProgression(at, this.pages().length));
  }

  preview(at: number): ScrubPreview {
    return { section: '', page: pageAtProgression(at, this.pages().length) };
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const step = { '+': 1, '=': 1, '-': -1 }[e.key];
    if (!step) return false;
    this.zoomBy(step * ZOOM_RANGE.step);
    return true;
  }

  act(action: ReaderKeyAction): boolean {
    const root = this.scroller().nativeElement;
    const last = this.pages().length;
    const moves: Partial<Record<ReaderKeyAction, () => void>> = {
      start: () => this.scrollToPage(1),
      end: () => this.scrollToPage(last),
      right: () => this.scrollToPage(Math.min(last, this.page() + 1)),
      left: () => this.scrollToPage(Math.max(1, this.page() - 1)),
      next: () => root.scrollBy({ top: root.clientHeight * 0.9 }),
      prev: () => root.scrollBy({ top: -root.clientHeight * 0.9 }),
    };
    const move = moves[action];
    move?.();
    return !!move;
  }
}
