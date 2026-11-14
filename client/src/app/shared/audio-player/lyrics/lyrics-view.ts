import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import type { AudioOutput } from '../../../core/services/audio-player/audio-output';
import type { StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { TvSectionDirective } from '../../directives/tv-section.directive';
import { SINGER_MARKS, singerStyle } from '../../../core/services/karaoke/singer-style';
import { SINGER_CHOICES, activeIndices, cueFills, cueSegments, singerChoice, toRows, type SingerChoice } from './lyrics-logic';

const MANUAL_SCROLL_MS = 3000;

/** Lyric lines that follow the player clock; a click on a timed line seeks to it. */
@Component({
  selector: 'app-lyrics-view',
  imports: [TvSectionDirective, TranslatePipe],
  templateUrl: './lyrics-view.html',
})
export class LyricsViewComponent {
  private readonly local = inject(AudioPlayerService);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  readonly doc = input.required<StructuredLyrics>();
  /** A translation or pronunciation with one line per main line, shown under each. */
  readonly layer = input<StructuredLyrics | null>(null);
  readonly large = input(false);
  /** The output the lines follow, when not the local player. */
  readonly output = input<AudioOutput | null>(null);
  /** False when the output cannot be driven: a tap on a line does nothing. */
  readonly seekable = input(true);

  /** Shows a singer picker under each line. */
  readonly singers = input(false);
  readonly singerPick = output<{ line: number; choice: SingerChoice }>();
  protected readonly choices = SINGER_CHOICES;

  private get audio(): AudioOutput {
    return this.output() ?? this.local;
  }

  protected readonly rows = computed(() => toRows(this.doc()));
  protected readonly segments = computed(() => this.rows().map((r) => (r.cues?.length ? cueSegments(r.text, r.cues) : null)));
  protected readonly layerRows = computed(() => (this.layer() ? toRows(this.layer()!) : null));
  protected readonly timed = computed(() => this.doc().synced && this.rows().every((r) => r.start !== undefined));
  protected readonly bgAgents = computed(() => new Set((this.doc().agents ?? []).filter((a) => a.role === 'bg').map((a) => a.id)));

  /** Interpolated player position in ms, advanced every frame while playing. */
  private readonly clock = signal(0);
  private readonly actives = computed(() => (this.timed() ? activeIndices(this.rows(), this.clock(), this.doc().offset) : []), {
    equal: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
  });
  protected readonly activeSet = computed(() => new Set(this.actives()));
  /** The view follows the first active line only. */
  private readonly first = computed(() => this.actives().reduce((m, i) => Math.min(m, i), Infinity));
  protected readonly fills = computed(() => {
    const t = this.clock();
    const off = this.doc().offset;
    return this.rows().map((r) => (r.cues ? cueFills(r.cues, t, off) : []));
  });

  private anchor = { pos: 0, at: 0 };
  private frame = 0;
  private manualUntil = 0;
  /** The first scroll of a view lands on the playing line at once; only later ones glide. */
  private placed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.frame));
    effect(() => {
      this.anchor = { pos: this.audio.position() * 1000, at: performance.now() };
      untracked(() => this.clock.set(this.anchor.pos));
    });
    effect(() => {
      const run = this.audio.playing() && this.timed();
      cancelAnimationFrame(this.frame);
      if (run) untracked(() => this.tick());
    });
    afterNextRender(() => {
      this.scrollToLine(untracked(this.first), 'instant');
      this.placed = true;
    });
    effect(() => {
      const i = this.first();
      if (this.placed) this.scrollToLine(i, 'smooth');
    });
  }

  private scrollToLine(i: number, behavior: ScrollBehavior): void {
    const box = this.scroller()?.nativeElement;
    const el = box?.querySelector<HTMLElement>(`[data-line="${i}"]`);
    if (!box || !el || performance.now() < this.manualUntil) return;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior });
  }

  private tick(): void {
    this.clock.set(this.anchor.pos + (performance.now() - this.anchor.at) * this.audio.rate());
    this.frame = requestAnimationFrame(() => this.tick());
  }

  protected onManualScroll(): void {
    this.manualUntil = performance.now() + MANUAL_SCROLL_MS;
  }

  protected seekTo(i: number): void {
    const s = this.rows()[i].start;
    if (s === undefined) return;
    this.manualUntil = 0;
    void this.audio.seek(Math.max(0, (s - this.doc().offset) / 1000));
  }

  protected fill(i: number, k: number): number {
    return this.fills()[i]?.[k] ?? 0;
  }

  /** The text between two words is lit once the word before it is, and a leading one with the first word. */
  protected gapLit(i: number, prev: number): boolean {
    return this.fill(i, Math.max(prev, 0)) >= (prev < 0 ? 1 : 100);
  }

  protected style(agentId?: string) {
    return singerStyle(this.doc(), agentId);
  }

  protected choice(agentId?: string): SingerChoice {
    return singerChoice(this.doc(), agentId);
  }

  protected choiceMark(c: SingerChoice): string {
    return c === 'none' ? '–' : c === 'both' ? SINGER_MARKS[0] + SINGER_MARKS[1] : SINGER_MARKS[+c - 1];
  }
}
