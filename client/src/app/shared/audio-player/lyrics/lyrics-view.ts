import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import type { StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { TvSectionDirective } from '../../directives/tv-section.directive';
import { activeIndex, cueFills, toRows } from './lyrics-logic';

const AGENT_COLOURS = ['text-primary', 'text-secondary', 'text-accent', 'text-info'];
const MANUAL_SCROLL_MS = 3000;

/** Lyric lines that follow the player clock; a click on a timed line seeks to it. */
@Component({
  selector: 'app-lyrics-view',
  imports: [TvSectionDirective],
  templateUrl: './lyrics-view.html',
})
export class LyricsViewComponent {
  protected readonly audio = inject(AudioPlayerService);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  readonly doc = input.required<StructuredLyrics>();
  /** A translation or pronunciation with one line per main line, shown under each. */
  readonly layer = input<StructuredLyrics | null>(null);
  readonly large = input(false);

  protected readonly rows = computed(() => toRows(this.doc()));
  protected readonly layerRows = computed(() => (this.layer() ? toRows(this.layer()!) : null));
  protected readonly timed = computed(() => this.doc().synced && this.rows().every((r) => r.start !== undefined));
  protected readonly bgAgents = computed(() => new Set((this.doc().agents ?? []).filter((a) => a.role === 'bg').map((a) => a.id)));

  /** Interpolated player position in ms, advanced every frame while playing. */
  private readonly clock = signal(0);
  protected readonly active = computed(() => (this.timed() ? activeIndex(this.rows(), this.clock(), this.doc().offset) : -1));
  protected readonly fills = computed(() => {
    const i = this.active();
    const cues = this.rows()[i]?.cues;
    return cues ? cueFills(cues, this.clock(), this.doc().offset) : [];
  });

  private anchor = { pos: 0, at: 0 };
  private frame = 0;
  private manualUntil = 0;

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
    effect(() => {
      const i = this.active();
      const box = this.scroller()?.nativeElement;
      const el = box?.querySelector<HTMLElement>(`[data-line="${i}"]`);
      if (!box || !el || performance.now() < this.manualUntil) return;
      box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
    });
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
    const a = this.active();
    return i < a ? 100 : i === a ? (this.fills()[k] ?? 0) : 0;
  }

  protected colour(agentId?: string): string {
    const agents = this.doc().agents ?? [];
    const idx = agents.findIndex((a) => a.id === agentId);
    return idx > 0 ? AGENT_COLOURS[(idx - 1) % AGENT_COLOURS.length] : '';
  }
}
