import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideMicVocal } from '@lucide/angular';
import { KaraokeApiService } from '../../../core/services/api/karaoke-api.service';
import type { KaraokeFailure, KaraokeItemState, KaraokeJobChanged, KaraokeStatus } from '../../../core/services/api/karaoke.models';
import { failureText } from '../../../core/services/karaoke/karaoke-failure';
import { LyricsApiService } from '../../../core/services/api/lyrics-api.service';
import type { LyricsFormat, LyricsKind, LyricsResponse, StructuredLyrics } from '../../../core/services/api/lyrics.models';
import type { StemMode } from '../../../core/services/audio-player/stem-mix';
import type { AudioOutput } from '../../../core/services/audio-player/audio-output';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { AuthService } from '../../../core/services/auth.service';
import { localizeLanguage } from '../../../core/utils/language.utils';
import { SseService } from '../../../core/services/sse.service';
import { DropdownMenuComponent } from '../../components/dropdown-menu';
import { TvSectionDirective } from '../../directives/tv-section.directive';
import { CdgCanvasComponent } from '../cdg/cdg-canvas';
import { KaraokeStageComponent } from '../karaoke/karaoke-stage';
import { LyricsViewComponent } from './lyrics-view';
import { layerAligned, tapBack, tapLines, tapStamp, tapStart, withSinger, type SingerChoice, type TapState } from './lyrics-logic';

const STEM_MODES: StemMode[] = ['original', 'guide', 'instrumental'];
const FORMATS: LyricsFormat[] = ['lrc', 'elrc', 'ttml', 'srt', 'plain'];
const EXTENSIONS: Record<string, LyricsFormat> = { lrc: 'lrc', elrc: 'elrc', ttml: 'ttml', xml: 'ttml', srt: 'srt', txt: 'plain' };

/** Lyrics of one track: pick a version, follow it, and (with `media.edit`) fix or add one. */
@Component({
  selector: 'app-lyrics-panel',
  imports: [FormsModule, TranslatePipe, DropdownMenuComponent, TvSectionDirective, LyricsViewComponent, KaraokeStageComponent, CdgCanvasComponent, LucideMicVocal],
  templateUrl: './lyrics-panel.html',
})
export class LyricsPanelComponent {
  private readonly api = inject(LyricsApiService);
  private readonly karaoke = inject(KaraokeApiService);
  private readonly translate = inject(TranslateService);
  protected readonly audio = inject(AudioPlayerService);
  protected readonly failure = (f: KaraokeFailure) => failureText(this.translate, f);
  protected readonly canEdit = inject(AuthService).hasPermission('media.edit');

  readonly itemId = input.required<number>();
  /** Shows the offset, import and fetch tools (with `media.edit`). */
  readonly edit = input(false);
  /** Another device's session: the lines follow it, and karaoke (local stems) is off. */
  readonly output = input<AudioOutput | null>(null);
  readonly seekable = input(true);
  /** Whether the track has lyrics, after each load. */
  readonly found = output<boolean>();

  protected readonly res = signal<LyricsResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly busy = signal(false);
  protected readonly mode = signal<'view' | 'import' | 'tap'>('view');
  /** The per-line singer picker is open. */
  protected readonly singers = signal(false);
  /** The karaoke view (pitch lane, scores) in place of the plain lyrics. */
  protected readonly stage = signal(false);

  private readonly mainId = signal<number | null>(null);
  protected readonly layerId = signal<number | null>(null);
  protected readonly docs = computed(() => this.res()?.structuredLyrics ?? []);
  protected readonly mains = computed(() => this.docs().filter((d) => d.kind === 'main'));
  protected readonly layers = computed(() => this.docs().filter((d) => d.kind !== 'main'));
  /** The karaoke view defaults to the first word-synced document: the only kind with a fill and a melody. */
  protected readonly main = computed(
    () =>
      this.mains().find((d) => d.id === this.mainId()) ??
      (this.stage() ? this.mains().find((d) => d.cueLine?.length) : undefined) ??
      this.mains()[0] ??
      null,
  );
  private readonly layer = computed(() => this.layers().find((d) => d.id === this.layerId()) ?? null);
  /** An aligned layer goes under each main line; any other replaces the main text. */
  protected readonly under = computed(() => {
    const m = this.main();
    const l = this.layer();
    return m && l && layerAligned(m, l) ? l : null;
  });
  protected readonly shown = computed(() => {
    const m = this.main();
    const l = this.layer();
    return l && !this.under() ? l : m;
  });

  protected readonly formats = FORMATS;
  protected readonly importText = signal('');
  protected readonly importFormat = signal<LyricsFormat>('plain');
  protected readonly importLang = signal('');
  protected readonly importKind = signal<LyricsKind>('main');
  protected readonly tap = signal<TapState>({ lines: [], next: 0 });
  protected readonly tapReady = computed(() => tapLines(this.tap()) !== null);

  protected readonly kStatus = signal<KaraokeStatus | null>(null);
  protected readonly kState = signal<KaraokeItemState | null>(null);
  protected readonly kBusy = signal(false);
  protected readonly stemModes = STEM_MODES;
  /** Karaoke controls apply to the track that is playing, in a library with the feature ready. */
  protected readonly karaokeOn = computed(
    () => !this.output() && !!this.kStatus()?.ready && this.audio.musicMode() && this.audio.track()?.itemId === this.itemId(),
  );

  private anchor = { pos: 0, at: 0 };

  constructor() {
    void this.karaoke.status().then((s) => this.kStatus.set(s), () => undefined);
    inject(SseService)
      .karaokeEvents.pipe(takeUntilDestroyed())
      .subscribe((e) => {
        if (e.type !== 'karaoke.job_changed') return;
        const j = e as unknown as KaraokeJobChanged;
        if (j.itemId === this.itemId()) void this.onJob(j);
      });
    effect(() => {
      const id = this.itemId();
      const on = this.karaokeOn();
      untracked(() => {
        this.kState.set(null);
        if (on) void this.loadKaraoke(id);
      });
    });
    effect(() => {
      const id = this.itemId();
      untracked(() => void this.load(id));
    });
    effect(() => {
      this.anchor = { pos: this.audio.position() * 1000, at: performance.now() };
    });
  }

  private async loadKaraoke(id: number): Promise<void> {
    try {
      const s = await this.karaoke.itemState(id);
      if (this.itemId() === id) this.kState.set(s);
    } catch {
      // No state: the block stays hidden.
    }
  }

  private async onJob(j: KaraokeJobChanged): Promise<void> {
    if (j.state === 'ready' || j.state === 'failed') {
      await this.loadKaraoke(j.itemId);
      if (j.state === 'ready') {
        void this.audio.refreshStems();
        void this.reload();
      }
      return;
    }
    this.kState.update((s) => s && { ...s, state: j.state, stage: j.stage, progress: j.progress });
  }

  protected prepare(): Promise<void> {
    return this.start({});
  }

  /** Redoes the lyrics timing (and the melody of the new lyrics) or the melody only; the stems stay. */
  protected recompute(part: 'sync' | 'melody'): Promise<void> {
    return this.start({ align: part === 'sync', melody: true, force: true });
  }

  private async start(body: { align?: boolean; melody?: boolean; force?: boolean }): Promise<void> {
    this.kBusy.set(true);
    try {
      const s = await this.karaoke.prepare(this.itemId(), body);
      this.kState.set(s);
      if (s.state === 'ready') void this.audio.refreshStems();
    } catch {
      // The interceptor toasts the reason.
    } finally {
      this.kBusy.set(false);
    }
  }

  private async load(id: number, run: () => Promise<LyricsResponse> = () => this.api.get(id)): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const r = await run();
      if (this.itemId() !== id) return;
      this.res.set(r);
      this.found.emit(r.structuredLyrics.length > 0);
      this.mainId.set(null);
      this.layerId.set(null);
    } catch {
      if (this.itemId() === id) {
        this.res.set(null);
        this.failed.set(true);
      }
    } finally {
      if (this.itemId() === id) this.loading.set(false);
    }
  }

  protected fetchFromProviders(): Promise<void> {
    return this.act(() => this.load(this.itemId(), () => this.api.fetch(this.itemId(), true)));
  }

  /** Runs a write, then reloads the list. */
  private async act(fn: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    try {
      await fn();
    } catch {
      this.failed.set(true);
    } finally {
      this.busy.set(false);
    }
  }

  private reload(): Promise<void> {
    return this.load(this.itemId());
  }

  protected prefer(d: StructuredLyrics): Promise<void> {
    return this.act(async () => {
      await this.api.patch(d.id, { preferred: true });
      await this.reload();
    });
  }

  protected remove(d: StructuredLyrics): Promise<void> {
    return this.act(async () => {
      await this.api.remove(d.id);
      await this.reload();
    });
  }

  protected setSinger(d: StructuredLyrics, e: { line: number; choice: SingerChoice }): Promise<void> {
    return this.act(async () => {
      await this.api.patch(d.id, withSinger(d, e.line, e.choice));
      await this.reload();
    });
  }

  protected pick(id: number): void {
    this.mainId.set(id);
  }

  protected toggleLayer(id: number): void {
    this.layerId.set(this.layerId() === id ? null : id);
  }

  protected async onFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.importText.set(await file.text());
    this.importFormat.set(EXTENSIONS[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'plain');
    input.value = '';
  }

  protected saveImport(): Promise<void> {
    const lang = this.importLang().trim().toLowerCase();
    return this.act(async () => {
      await this.api.put(this.itemId(), {
        kind: this.importKind(),
        ...(lang ? { lang } : {}),
        format: this.importFormat(),
        body: this.importText(),
      });
      this.importText.set('');
      this.mode.set('view');
      await this.reload();
    });
  }

  /** Starts tap-sync from the pasted text, else from the lines on screen. */
  protected startTap(): void {
    const text = this.importText().trim() || (this.main()?.line.map((l) => l.value).join('\n') ?? '');
    this.tap.set(tapStart(text));
    this.mode.set('tap');
  }

  protected stamp(): void {
    const ms = this.anchor.pos + (this.audio.playing() ? (performance.now() - this.anchor.at) * this.audio.rate() : 0);
    this.tap.update((s) => tapStamp(s, ms));
  }

  protected back(): void {
    this.tap.update(tapBack);
  }

  protected saveTap(): Promise<void> {
    const lines = tapLines(this.tap());
    if (!lines) return Promise.resolve();
    const lang = this.importLang().trim().toLowerCase();
    return this.act(async () => {
      await this.api.put(this.itemId(), { kind: 'main', ...(lang ? { lang } : {}), lines });
      this.mode.set('view');
      await this.reload();
    });
  }

  protected label(d: StructuredLyrics): string {
    const source = d.source.startsWith('provider:')
      ? (d.sourceLabel ?? d.source.slice(d.source.lastIndexOf(':') + 1))
      : this.translate.instant(`lyrics.source_${d.source}`);
    return d.lang === 'und' ? source : `${localizeLanguage(d.lang, this.translate)} · ${source}`;
  }
}
