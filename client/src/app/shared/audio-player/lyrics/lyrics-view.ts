import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { DeviceService } from '../../../core/services/device.service';
import type { AudioOutput } from '../../../core/services/audio-player/audio-output';
import type { StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { TvSectionDirective } from '../../directives/tv-section.directive';
import { sides } from '../../../core/services/karaoke/karaoke-score';
import { singerStyle } from '../../../core/services/karaoke/singer-style';
import { activeIndices, cueFills, cuesEnd, cueSegments, toRows } from './lyrics-logic';

const MANUAL_SCROLL_MS = 3000;
const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
/** One text layer: a hard-stop gradient clipped to the glyphs fills the sung part, so no second copy shows through. */
const SWEEP = 'whitespace-pre-wrap bg-clip-text [-webkit-text-fill-color:transparent] bg-[linear-gradient(to_right,var(--on)_var(--p),var(--off)_var(--p))]';

/** Lyric lines that follow the player clock; a click on a timed line seeks to it. */
@Component({
  selector: 'app-lyrics-view',
  imports: [TvSectionDirective, TranslatePipe],
  templateUrl: './lyrics-view.html',
})
export class LyricsViewComponent {
  private readonly local = inject(AudioPlayerService);
  /** On TV the lines follow the song only: no D-pad focus on them, no manual scroll. */
  protected readonly tv = inject(DeviceService).isTv;
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  readonly doc = input.required<StructuredLyrics>();
  /** A translation or pronunciation with one line per main line, shown under each. */
  readonly layer = input<StructuredLyrics | null>(null);
  readonly large = input(false);
  /** The output the lines follow, when not the local player. */
  readonly output = input<AudioOutput | null>(null);
  /** False when the output cannot be driven: a tap on a line does nothing. */
  readonly seekable = input(true);

  private get audio(): AudioOutput {
    return this.output() ?? this.local;
  }

  private readonly sweepLive = `${SWEEP} [--on:var(--color-primary)] [--off:currentColor]`;
  private readonly sweepIdle = `${SWEEP} [--on:currentColor] [--off:currentColor]`;
  private readonly sweepPlain = `${SWEEP} [--on:currentColor] [--off:color-mix(in_oklab,currentColor_40%,transparent)]`;
  protected readonly rows = computed(() => toRows(this.doc()));
  protected readonly segments = computed(() => this.rows().map((r) => (r.cues?.length ? cueSegments(r.text, r.cues) : null)));
  protected readonly layerRows = computed(() => (this.layer() ? toRows(this.layer()!) : null));
  protected readonly timed = computed(() => this.doc().synced && this.rows().every((r) => r.start !== undefined));
  protected readonly bgAgents = computed(() => new Set((this.doc().agents ?? []).filter((a) => a.role === 'bg').map((a) => a.id)));

  /** Interpolated player position in ms, advanced every frame while playing. */
  private pos = 0;
  /** The position the template shows: written only when the active lines or a word's state change. */
  private readonly clock = signal(0);
  private readonly actives = computed(() => this.activesAt(this.clock()), { equal: sameList });
  protected readonly activeSet = computed(() => new Set(this.actives()));
  /** How many rows have started: the rows before it that are not active are sung. */
  private readonly started = computed(() => {
    const t = this.clock() + this.doc().offset;
    return this.rows().filter((r) => r.start !== undefined && r.start <= t).length;
  });
  /** The view follows the first active line only. */
  private readonly first = computed(() => this.actives().reduce((m, i) => Math.min(m, i), Infinity));
  /** Cue span of each row, measured once per document. */
  private readonly spans = computed(() => this.rows().map((r) => (r.cues?.length ? { lo: Math.min(...r.cues.map((c) => c.start)), hi: cuesEnd(r.cues), full: r.cues.map(() => 100) } : null)));
  /** Fill of each cue, 0 or 100, or -1 while it is sung: the frame loop paints those. */
  protected readonly fills = computed(() => this.fillsAt(this.clock()));

  private anchor = { pos: 0, at: 0 };
  private frame = 0;
  private manualUntil = 0;
  /** The first scroll of a view lands on the playing line at once; only later ones glide. */
  private placed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.frame));
    effect(() => {
      this.audio.playing();
      this.audio.buffering();
      this.anchor = { pos: this.audio.position() * 1000, at: performance.now() };
      untracked(() => this.sync(this.anchor.pos));
    });
    effect(() => {
      const run = this.audio.playing() && !this.audio.buffering() && this.timed();
      cancelAnimationFrame(this.frame);
      if (run) untracked(() => this.tick());
    });
    afterNextRender(() => {
      this.scrollToLine(untracked(this.first), 'instant');
      this.placed = true;
      // Passive: a template binding is non-passive and would hold touch scrolling on the main thread.
      const box = this.scroller()?.nativeElement;
      if (!box) return;
      const onManual = () => this.onManualScroll();
      box.addEventListener('wheel', onManual, { passive: true });
      box.addEventListener('touchmove', onManual, { passive: true });
    });
    effect(() => {
      const i = this.first();
      if (this.placed) this.scrollToLine(i, 'smooth');
    });
    effect(() => {
      this.doc();
      untracked(() => {
        this.manualUntil = 0;
        this.sync(this.pos);
        const box = this.scroller()?.nativeElement;
        if (box) box.scrollTop = 0;
      });
    });
  }

  private scrollToLine(i: number, behavior: ScrollBehavior): void {
    const box = this.scroller()?.nativeElement;
    const el = box?.querySelector<HTMLElement>(`[data-line="${i}"]`);
    if (!box || !el || performance.now() < this.manualUntil) return;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior });
  }

  private tick(): void {
    this.sync(this.anchor.pos + (performance.now() - this.anchor.at) * this.audio.rate());
    this.frame = requestAnimationFrame(() => this.tick());
  }

  private activesAt(pos: number): number[] {
    return this.timed() ? activeIndices(this.rows(), pos, this.doc().offset) : [];
  }

  /** Only a row being sung needs its fills computed; the others are all empty or all full. */
  private fillsAt(pos: number): number[][] {
    const t = pos + this.doc().offset;
    const spans = this.spans();
    return this.rows().map((r, i) => {
      const sp = spans[i];
      if (!r.cues || !sp || t <= sp.lo) return [];
      return t >= sp.hi ? sp.full : cueFills(r.cues, t, 0).map((f) => (f > 0 && f < 100 ? -1 : f));
    });
  }

  /** Change detection runs only when the template changes; the words being sung are painted here. */
  private sync(pos: number): void {
    this.pos = pos;
    const shown = this.fills();
    const same = this.fillsAt(pos).every((r, i) => r === shown[i] || sameList(r, shown[i]));
    if (!same || !sameList(this.activesAt(pos), this.actives())) this.clock.set(pos);
    const box = this.scroller()?.nativeElement;
    this.fills().forEach((r, i) =>
      r.forEach((f, k) => {
        if (f < 0) box?.querySelector<HTMLElement>(`[data-line="${i}"] [data-cue="${k}"]`)?.style.setProperty('--p', this.wipe(i, k));
      }),
    );
  }

  private onManualScroll(): void {
    this.manualUntil = performance.now() + MANUAL_SCROLL_MS;
  }

  protected seekTo(i: number): void {
    const s = this.rows()[i].start;
    if (s === undefined) return;
    this.manualUntil = 0;
    void this.audio.seek(Math.max(0, (s - this.doc().offset) / 1000));
  }

  /** A word the alignment placed by interpolation. */
  protected readonly guessedMark = ' underline decoration-dotted decoration-1 underline-offset-4';

  /** The karaoke stage, solo: the unsung words stay white, the sung ones take a light primary. */
  protected staged(r: { agentId?: string }): boolean {
    return this.large() && !this.style(r.agentId)?.colour;
  }

  /** Only the line being sung takes the primary sweep on the stage; sung and coming lines stay neutral. */
  protected sweepOf(i: number, r: { agentId?: string }): string {
    if (!this.staged(r)) return this.sweepPlain;
    return this.activeSet().has(i) ? this.sweepLive : this.sweepIdle;
  }

  /** On the stage the line being sung is full, the sung ones fade out and the coming ones stay readable. */
  protected rowOpacity(i: number, r: { agentId?: string; cues?: unknown }): string {
    if (!this.timed()) return 'opacity-100';
    const active = this.activeSet().has(i);
    if (this.staged(r)) return active ? 'opacity-100' : i < this.started() ? 'opacity-35' : 'opacity-70';
    return active || r.cues ? 'opacity-100' : 'opacity-40';
  }

  protected fill(i: number, k: number): number {
    return this.fills()[i]?.[k] ?? 0;
  }

  /** Sung share of a cue as a percentage; a cue being sung is read at the live position. */
  protected wipe(i: number, k: number): string {
    const f = this.fill(i, k);
    return `${f < 0 ? cueFills([this.rows()[i].cues![k]], this.pos, this.doc().offset)[0] : f}%`;
  }

  /** The text between two words is lit once the word before it is, and a leading one with the first word. */
  protected gapLit(i: number, prev: number): boolean {
    const f = this.fill(i, Math.max(prev, 0));
    return prev < 0 ? f !== 0 : f >= 100;
  }

  protected readonly duet = computed(() => sides(this.doc()).length > 1);

  protected style(agentId?: string) {
    return singerStyle(this.doc(), agentId);
  }
}
