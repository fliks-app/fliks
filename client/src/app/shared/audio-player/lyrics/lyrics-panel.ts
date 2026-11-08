import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideChevronDown, LucidePause, LucidePlay } from '@lucide/angular';
import { LyricsApiService } from '../../../core/services/api/lyrics-api.service';
import type { LyricsFormat, LyricsKind, LyricsResponse, StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { AuthService } from '../../../core/services/auth.service';
import { TvSectionDirective } from '../../directives/tv-section.directive';
import { LyricsViewComponent } from './lyrics-view';
import { layerAligned, tapBack, tapLines, tapStamp, tapStart, type TapState } from './lyrics-logic';

const OFFSET_LIMIT = 60000;
const FORMATS: LyricsFormat[] = ['lrc', 'elrc', 'ttml', 'srt', 'plain'];
const EXTENSIONS: Record<string, LyricsFormat> = { lrc: 'lrc', elrc: 'elrc', ttml: 'ttml', xml: 'ttml', srt: 'srt', txt: 'plain' };

/** Lyrics of one track: pick a version, follow it, and (with `media.edit`) fix or add one. */
@Component({
  selector: 'app-lyrics-panel',
  imports: [FormsModule, TranslatePipe, TvSectionDirective, LyricsViewComponent, LucideChevronDown, LucidePause, LucidePlay],
  templateUrl: './lyrics-panel.html',
})
export class LyricsPanelComponent {
  private readonly api = inject(LyricsApiService);
  protected readonly audio = inject(AudioPlayerService);
  protected readonly canEdit = inject(AuthService).hasPermission('media.edit');

  readonly itemId = input.required<number>();
  readonly fullscreen = input(false);
  readonly closed = output<void>();

  protected readonly res = signal<LyricsResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly busy = signal(false);
  protected readonly mode = signal<'view' | 'import' | 'tap'>('view');

  private readonly mainId = signal<number | null>(null);
  protected readonly layerId = signal<number | null>(null);
  protected readonly docs = computed(() => this.res()?.structuredLyrics ?? []);
  protected readonly mains = computed(() => this.docs().filter((d) => d.kind === 'main'));
  protected readonly layers = computed(() => this.docs().filter((d) => d.kind !== 'main'));
  protected readonly main = computed(() => this.mains().find((d) => d.id === this.mainId()) ?? this.mains()[0] ?? null);
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

  private anchor = { pos: 0, at: 0 };

  constructor() {
    effect(() => {
      const id = this.itemId();
      untracked(() => void this.load(id));
    });
    effect(() => {
      this.anchor = { pos: this.audio.position() * 1000, at: performance.now() };
    });
  }

  private async load(id: number, run: () => Promise<LyricsResponse> = () => this.api.get(id)): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const r = await run();
      if (this.itemId() !== id) return;
      this.res.set(r);
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

  protected nudge(d: StructuredLyrics, delta: number | 'reset'): Promise<void> {
    const offset = delta === 'reset' ? 0 : Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, d.offset + delta));
    return this.act(async () => {
      await this.api.patch(d.id, { offsetMs: offset });
      this.res.update((r) => r && { ...r, structuredLyrics: r.structuredLyrics.map((x) => (x.id === d.id ? { ...x, offset } : x)) });
    });
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
    return d.lang === 'und' ? d.source : `${d.lang} · ${d.source}`;
  }
}
