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
import { TranslatePipe } from '@ngx-translate/core';
import type { ComicPageSize } from '../../../../core/services/api/comics.models';
import { ComicsApiService } from '../../../../core/services/api/comics-api.service';
import {
  COMIC_PREFS_DEFAULT,
  ZOOM_MAX,
  buildSpreads,
  drawOrder,
  pageWidth,
  preloadScreens,
  reportedPage,
  spreadIndexOf,
  stepToward,
  widthBucket,
  zoomAt,
  type ComicPrefs,
  type Pan,
} from '../../comic-layout';
import { pageAtProbe, scrollToPageSlot } from '../../page-scroll';
import { pageAtProgression, pdfPageOf, pdfProgression } from '../../pdf-position';
import { ReaderApiService, type ReaderTarget } from '../../reader-api.service';
import type { ReaderEngine, ReaderLayout, ReaderStatus, ReaderZoom, ScrubPreview } from '../../reader-engine';
import type { ReaderKeyAction } from '../../reader-keys';
import { ReaderProgressService } from '../../reader-progress.service';
import { ReaderSession } from '../../reader-session';
import { ReaderSettingsService } from '../../reader-settings.service';
import { ComicGestures } from './comic-gestures';

const KEY_ZOOM_STEP = 0.5;
/** A webtoon column is capped like a phone-width strip: wider than this the art is only stretched. */
const WEBTOON_MAX_CSS = 900;
const WEBTOON_ZOOM = { min: 0.5, max: 2, step: 0.25 } as const;

/** The image pages of a comic issue: paged (single or spread, left-to-right or manga) or a webtoon strip. */
@Component({
  selector: 'app-comic-engine',
  imports: [TranslatePipe],
  templateUrl: './comic-engine.html',
  styleUrl: './comic-engine.css',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComicEngineComponent implements ReaderEngine, OnDestroy {
  readonly target = input.required<ReaderTarget>();
  readonly pages = input.required<ComicPageSize[]>();

  private readonly api = inject(ComicsApiService);
  private readonly readerApi = inject(ReaderApiService);
  private readonly settings = inject(ReaderSettingsService);
  private readonly progress = inject(ReaderProgressService);
  private readonly session = inject(ReaderSession);
  private readonly injector = inject(Injector);
  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');

  private readonly resizer = new ResizeObserver(() => this.measure());
  private raf = 0;
  private destroyed = false;
  private readonly preloaded = new Set<string>();

  protected readonly prefs = signal<ComicPrefs>(COMIC_PREFS_DEFAULT);
  protected readonly webtoon = computed(() => this.prefs().mode === 'webtoon');
  readonly rtl = computed(() => this.prefs().mode === 'manga');
  protected readonly spreads = computed(() => buildSpreads(this.pages(), this.prefs().spread && !this.webtoon()));
  protected readonly index = signal(0);
  protected readonly shown = computed(() => drawOrder(this.spreads()[this.index()] ?? [], this.rtl()));
  protected readonly page = signal(1);
  protected readonly total = computed(() => this.pages().length);
  protected readonly ready = signal(false);
  readonly loading = computed(() => !this.ready());
  readonly steps = this.total;
  readonly progression = computed(() => pdfProgression(this.page(), this.total()));
  readonly segments = signal([0]);
  readonly status = computed<ReaderStatus>(() => ({
    section: '',
    sectionLeft: null,
    page: this.page(),
    pages: this.total(),
    bookLeft: null,
  }));
  protected readonly view = signal({ w: 0, h: 0 });
  protected readonly scale = signal(1);
  protected readonly pan = signal<Pan>({ x: 0, y: 0 });
  protected readonly webZoom = signal(1);
  protected readonly zoomTier = computed(() => (this.scale() > 1.25 ? 2 : 1));
  protected readonly transform = computed(() => `translate(${this.pan().x}px, ${this.pan().y}px) scale(${this.scale()})`);
  readonly zoom: ReaderZoom = {
    canOut: computed(() => (this.webtoon() ? this.webZoom() > WEBTOON_ZOOM.min : this.scale() > 1)),
    canIn: computed(() => (this.webtoon() ? this.webZoom() < WEBTOON_ZOOM.max : this.scale() < ZOOM_MAX)),
    by: (dir) => this.zoomBy(dir),
  };
  readonly layout: ReaderLayout = { prefs: this.prefs, set: (p) => this.setPrefs(p) };
  protected readonly gestures = new ComicGestures({
    scale: this.scale,
    pan: this.pan,
    view: this.view,
    rtl: this.rtl,
    webtoon: this.webtoon,
    stage: () => this.stage()!.nativeElement,
    zoomTo: (next, anchor) => this.zoomTo(next, anchor),
    zoomBy: (dir) => this.zoomBy(dir),
    resetZoom: () => this.resetZoom(),
    step: (dir) => this.step(dir),
    toggleChrome: () => this.session.toggleChrome(),
  });
  protected readonly webtoonWidth = computed(() => Math.round(Math.min(this.view().w, WEBTOON_MAX_CSS) * this.webZoom()));

  constructor() {
    this.session.attach(this);
    afterNextRender(() => void this.open());
    // A mode switch replaces the stage element.
    effect(() => {
      const el = this.stage()?.nativeElement;
      untracked(() => {
        this.resizer.disconnect();
        if (el) this.resizer.observe(el);
      });
    });
    effect(() => {
      const at = this.index();
      const spreads = this.spreads();
      const view = this.view();
      if (!this.ready() || this.webtoon() || !view.w) return;
      untracked(() => {
        this.resetZoom();
        this.report(reportedPage(spreads[at] ?? [1]));
        this.preload(spreads, at);
      });
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.gestures.dispose();
    cancelAnimationFrame(this.raf);
    this.resizer.disconnect();
    void this.progress.flush();
  }

  private measure(): void {
    const el = this.stage()?.nativeElement;
    if (el) this.view.set({ w: el.clientWidth, h: el.clientHeight });
  }

  private async open(): Promise<void> {
    const t = this.target();
    this.prefs.set(this.settings.comicPrefs(t.mediaId));
    const [saved] = await Promise.all([this.readerApi.loadProgress(t).catch(() => null), this.api.prepare(t.fileId).catch(() => undefined)]);
    if (this.destroyed) return;
    this.measure();
    const at = pdfPageOf(saved?.locator, this.total());
    this.page.set(at);
    this.index.set(spreadIndexOf(this.spreads(), at));
    this.ready.set(true);
    if (this.webtoon()) afterNextRender(() => this.scrollToPage(at), { injector: this.injector });
    else if (this.total() === 1) this.report(1);
  }

  /** The URL of a page at the width its place on screen asks for. */
  protected src(n: number, count = this.shown().length, tier = this.zoomTier()): string {
    const size = this.pages()[n - 1];
    const dpr = window.devicePixelRatio || 1;
    const width = this.webtoon() ? widthBucket(this.webtoonWidth(), dpr) : pageWidth(size, this.view(), count, dpr, tier);
    const t = this.target();
    return this.api.pageUrl(t.itemId, t.fileId, n - 1, width);
  }

  protected aspect(n: number): string {
    const p = this.pages()[n - 1];
    return `${p.width} / ${p.height}`;
  }

  /** Warms the cache for the next screens: the browser reuses the response when they come up. */
  private preload(spreads: number[][], at: number): void {
    for (const i of preloadScreens(spreads, at)) {
      for (const n of spreads[i]) {
        const url = this.src(n, spreads[i].length, 1);
        if (this.preloaded.has(url)) continue;
        this.preloaded.add(url);
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
      }
    }
  }

  private report(n: number): void {
    this.page.set(n);
    void this.api.prepare(this.target().fileId).catch(() => undefined);
    this.progress.report(this.target(), { progression: pdfProgression(n, this.total()), locator: { page: n } });
  }

  /** A new mode or spread keeps the page on screen. */
  private setPrefs(p: ComicPrefs): void {
    const at = this.page();
    const modeChanged = p.mode !== this.prefs().mode;
    this.prefs.set(p);
    this.settings.saveComicPrefs(this.target().mediaId, p);
    if (modeChanged) this.resetZoom();
    this.index.set(spreadIndexOf(this.spreads(), at));
    if (modeChanged && p.mode === 'webtoon') afterNextRender(() => this.scrollToPage(at), { injector: this.injector });
  }

  /** `dir` follows the reading order: 1 is forward whatever side of the screen it is on. */
  protected step(dir: 1 | -1): void {
    const next = this.index() + dir;
    if (next >= 0 && next < this.spreads().length) this.index.set(next);
  }

  private goTo(n: number): void {
    if (this.webtoon()) this.scrollToPage(n);
    else this.index.set(spreadIndexOf(this.spreads(), n));
  }

  private scrollToPage(n: number): void {
    scrollToPageSlot(this.stage()!.nativeElement, n);
  }

  seek(at: number): void {
    this.goTo(pageAtProgression(at, this.total()));
  }

  preview(at: number): ScrubPreview {
    return { section: '', page: pageAtProgression(at, this.total()) };
  }

  // ---- webtoon

  protected toggleChrome(): void {
    this.session.toggleChrome();
  }

  protected onScroll(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      const n = pageAtProbe(this.stage()!.nativeElement);
      if (this.ready() && n !== this.page()) this.report(n);
    });
  }

  // ---- zoom

  private zoomBy(dir: 1 | -1): void {
    if (this.webtoon()) {
      const at = this.page();
      this.webZoom.set(Math.min(WEBTOON_ZOOM.max, Math.max(WEBTOON_ZOOM.min, this.webZoom() + dir * WEBTOON_ZOOM.step)));
      afterNextRender(() => this.scrollToPage(at), { injector: this.injector });
    } else {
      this.zoomTo(this.scale() + dir * KEY_ZOOM_STEP, { x: 0, y: 0 });
    }
  }

  private zoomTo(next: number, anchor: Pan): void {
    const r = zoomAt(this.pan(), this.scale(), next, anchor, this.view());
    this.scale.set(r.scale);
    this.pan.set(r.pan);
  }

  private resetZoom(): void {
    this.scale.set(1);
    this.pan.set({ x: 0, y: 0 });
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const keys: Record<string, () => void> = {
      '+': () => this.zoomBy(1),
      '=': () => this.zoomBy(1),
      '-': () => this.zoomBy(-1),
      '0': () => (this.webtoon() ? this.webZoom.set(1) : this.resetZoom()),
    };
    keys[e.key]?.();
    return !!keys[e.key];
  }

  act(action: ReaderKeyAction): boolean {
    const root = this.stage()!.nativeElement;
    const screen = (dir: 1 | -1) => () => root.scrollBy({ top: dir * root.clientHeight * 0.9 });
    const moves: Partial<Record<ReaderKeyAction, () => void>> = this.webtoon()
      ? { next: screen(1), prev: screen(-1) }
      : {
          left: () => this.step(stepToward('left', this.rtl())),
          right: () => this.step(stepToward('right', this.rtl())),
          next: () => this.step(1),
          prev: () => this.step(-1),
        };
    moves.start = () => this.goTo(1);
    moves.end = () => this.goTo(this.total());
    if (action === 'close') {
      if (this.scale() === 1) return false;
      this.resetZoom();
      return true;
    }
    const move = moves[action];
    move?.();
    return !!move;
  }
}
