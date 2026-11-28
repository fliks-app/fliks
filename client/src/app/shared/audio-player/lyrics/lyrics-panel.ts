import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../icons';
import type { KaraokeFailure } from '../../../core/services/api/karaoke.models';
import { DeviceService } from '../../../core/services/device.service';
import { KaraokeService } from '../../../core/services/karaoke/karaoke.service';
import { failureText } from '../../../core/services/karaoke/karaoke-failure';
import { LyricsApiService } from '../../../core/services/api/lyrics-api.service';
import type { LyricsFormat, LyricsKind, LyricsResponse, StructuredLyrics } from '../../../core/services/api/lyrics.models';
import type { AudioOutput } from '../../../core/services/audio-player/audio-output';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { AuthService } from '../../../core/services/auth.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { TvSectionDirective } from '../../directives/tv-section.directive';
import { CdgCanvasComponent } from '../cdg/cdg-canvas';
import { KaraokeStageComponent } from '../karaoke/karaoke-stage';
import { LyricsViewComponent } from './lyrics-view';
import { layerAligned, mainLyrics, tapBack, tapLines, tapStamp, tapStart, type TapState } from './lyrics-logic';

const FORMATS: LyricsFormat[] = ['lrc', 'elrc', 'ttml', 'srt', 'plain'];
const EXTENSIONS: Record<string, LyricsFormat> = { lrc: 'lrc', elrc: 'elrc', ttml: 'ttml', xml: 'ttml', srt: 'srt', txt: 'plain' };
const NO_LYRICS: StructuredLyrics = {
  id: 0, kind: 'main', lang: 'und', synced: false, offset: 0, displayArtist: '', displayTitle: '', source: '', reviewed: false, preferred: false, line: [],
};

/** Lyrics of one track: pick a version, follow it, and (with `media.edit`) fix or add one. */
@Component({
  selector: 'app-lyrics-panel',
  imports: [FormsModule, TranslatePipe, LucideDynamicIcon, TvSectionDirective, LyricsViewComponent, KaraokeStageComponent, CdgCanvasComponent],
  templateUrl: './lyrics-panel.html',
})
export class LyricsPanelComponent {
  private readonly api = inject(LyricsApiService);
  protected readonly session = inject(KaraokeService);
  protected readonly icons = icons;
  private readonly translate = inject(TranslateService);
  private readonly confirm = inject(ConfirmationService);
  private readonly local = inject(AudioPlayerService);
  protected readonly failure = (f: KaraokeFailure) => failureText(this.translate, f);
  protected readonly tv = inject(DeviceService).isTv;
  protected readonly canEdit = inject(AuthService).hasPermission('media.edit');

  readonly itemId = input.required<number>();
  /** Shows the import and fetch tools (with `media.edit`). */
  readonly edit = input(false);
  /** Another device's session: the lines and the karaoke stage follow it. */
  readonly output = input<AudioOutput | null>(null);
  readonly seekable = input(true);

  protected get audio(): AudioOutput {
    return this.output() ?? this.local;
  }
  /** Whether the track has lyrics, after each load. */
  readonly found = output<boolean>();

  protected readonly res = signal<LyricsResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly busy = signal(false);
  protected readonly mode = signal<'view' | 'import' | 'tap'>('view');
  /** The karaoke view (pitch lane, scores) in place of the plain lyrics; the service owns it so it survives hiding the lyrics. */
  private readonly stage = this.session.stage;

  readonly layerId = signal<number | null>(null);
  protected readonly docs = computed(() => this.res()?.structuredLyrics ?? []);
  /** Translations and pronunciations, picked from the player's menu. */
  readonly layers = computed(() => this.docs().filter((d) => d.kind !== 'main'));
  protected readonly main = computed(() => mainLyrics(this.docs(), this.stage()));
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

  /** The karaoke state is the displayed track's: this panel may still show the one before. */
  private readonly current = computed(() => this.session.itemId() === this.itemId());
  protected readonly kState = computed(() => (this.current() ? this.session.itemState() : null));
  /** The karaoke view once the stems play; a track with no lyrics sings over an empty page. */
  protected readonly staged = computed(() => this.current() && this.session.singKind() === 'exit');
  protected readonly stageDoc = computed(() => (this.staged() ? (this.shown() ?? NO_LYRICS) : null));

  private anchor = { pos: 0, at: 0 };

  constructor() {
    inject(DestroyRef).onDestroy(() => this.session.stopSinging());
    // The mic outlives the stage, which is rebuilt on every track: it stops with karaoke, not with the track.
    effect(() => {
      if (!this.stage()) untracked(() => (this.session.singing() || this.session.starting()) && this.session.stopSinging());
    });
    this.session.prepared.pipe(takeUntilDestroyed()).subscribe((id) => {
      if (id === this.itemId()) void this.reload();
    });
    effect(() => {
      const id = this.itemId();
      untracked(() => void this.load(id));
    });
    effect(() => {
      this.audio.playing();
      this.audio.buffering();
      this.anchor = { pos: this.audio.position() * 1000, at: performance.now() };
    });
  }

  /** Redoes the lyrics timing (and the melody of the new lyrics) or the melody only; the stems stay. */
  protected recompute(part: 'sync' | 'melody'): Promise<void> {
    return this.session.prepare({ align: part === 'sync', melody: true, force: true });
  }

  /** Cancels a preparation, or drops the track's stems and generated lyrics. */
  protected async removeKaraoke(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('karaoke.remove_title'),
      message: this.translate.instant('karaoke.remove_message'),
      confirmLabel: this.translate.instant('common.delete'),
      variant: 'danger',
    });
    if (ok) await this.session.remove();
  }

  /** A generated sync the user keeps: a re-sync never replaces a reviewed row. */
  protected keep(d: StructuredLyrics): Promise<void> {
    return this.act(async () => {
      await this.api.patch(d.id, { reviewed: true });
      await this.reload();
    });
  }

  private async load(id: number, run: () => Promise<LyricsResponse> = () => this.api.get(id)): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const r = await run();
      if (this.itemId() !== id) return;
      this.res.set(r);
      this.found.emit(r.structuredLyrics.length > 0);
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

  protected async remove(d: StructuredLyrics): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('lyrics.delete_title'),
      message: this.translate.instant('lyrics.delete_message'),
      confirmLabel: this.translate.instant('common.delete'),
      variant: 'danger',
    });
    if (!ok) return;
    return this.act(async () => {
      await this.api.remove(d.id);
      await this.reload();
    });
  }

  toggleLayer(id: number): void {
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
    const ms = this.anchor.pos + (this.audio.playing() && !this.audio.buffering() ? (performance.now() - this.anchor.at) * this.audio.rate() : 0);
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
}
