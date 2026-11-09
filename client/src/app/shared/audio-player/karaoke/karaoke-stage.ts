import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideMic, LucideMicOff, LucideMinus, LucidePlus } from '@lucide/angular';
import type { StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { DeviceService } from '../../../core/services/device.service';
import { KaraokeRelayService } from '../../../core/services/karaoke/karaoke-relay.service';
import { KaraokeService, type BoardRow } from '../../../core/services/karaoke/karaoke.service';
import { foldPitch, laneNotes } from '../../../core/services/karaoke/pitch-lane';
import type { Difficulty } from '../../../core/services/karaoke/karaoke-score';
import { PartyService } from '../../../core/services/party/party.service';
import { TvSectionDirective } from '../../directives/tv-section.directive';
import { LyricsViewComponent } from '../lyrics/lyrics-view';
import { KaraokeQueueComponent } from './karaoke-queue';

const BEHIND_MS = 2000;
const AHEAD_MS = 6000;
const RESULTS_MS = 500;
const SINGER_COLOURS = ['#22c55e', '#38bdf8', '#f472b6', '#facc15'];
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/** The karaoke view: lyrics with word fill, the reference melody as a pitch lane, live scores and the singers' controls. */
@Component({
  selector: 'app-karaoke-stage',
  imports: [TranslatePipe, TvSectionDirective, LyricsViewComponent, KaraokeQueueComponent, LucideMic, LucideMicOff, LucideMinus, LucidePlus],
  templateUrl: './karaoke-stage.html',
})
export class KaraokeStageComponent {
  protected readonly karaoke = inject(KaraokeService);
  protected readonly audio = inject(AudioPlayerService);
  protected readonly tv = inject(DeviceService).isTv;
  private readonly relay = inject(KaraokeRelayService);
  private readonly party = inject(PartyService);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('lane');
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('board');

  readonly doc = input.required<StructuredLyrics>();
  readonly title = input('');

  protected readonly difficulties = DIFFICULTIES;
  protected readonly rows = signal<BoardRow[]>([]);
  protected readonly calibrated = signal<boolean | null>(null);
  protected readonly hasMelody = computed(() => (this.doc().cueLine ?? []).some((l) => l.cue.some((c) => c.pitch !== undefined)));
  protected readonly canSing = this.karaoke.canSing;
  protected readonly inParty = this.party.active;

  private frame = 0;

  constructor() {
    const destroyRef = inject(DestroyRef);
    const timer = setInterval(() => this.refresh(), RESULTS_MS);
    destroyRef.onDestroy(() => {
      clearInterval(timer);
      cancelAnimationFrame(this.frame);
      this.karaoke.stopSinging();
      this.relay.close('display');
    });
    effect(() => {
      if (this.party.active() && this.party.isHost()) untracked(() => this.relay.open('display'));
    });
    effect(() => {
      const board = this.karaoke.board();
      const el = this.dialog()?.nativeElement;
      if (board && el && !el.open) el.showModal();
    });
    effect(() => {
      this.doc();
      untracked(() => {
        cancelAnimationFrame(this.frame);
        this.draw();
      });
    });
  }

  private refresh(): void {
    this.rows.set(this.karaoke.results(this.doc()));
    const dur = this.audio.duration();
    if (dur > 0 && this.audio.position() >= dur - 1.5) this.karaoke.finish(this.doc(), this.title());
  }

  protected toggleSinging(): void {
    if (this.karaoke.singing()) this.karaoke.stopSinging();
    else void this.karaoke.startSinging();
  }

  protected calibrate(): void {
    this.calibrated.set(this.karaoke.calibrate(this.doc()));
  }

  protected setPitch(delta: number): void {
    void this.audio.setPitch(delta === 0 ? 0 : this.audio.pitch() + delta);
  }

  protected closeBoard(): void {
    this.dialog()?.nativeElement.close();
  }

  protected colour(i: number): string {
    return SINGER_COLOURS[i % SINGER_COLOURS.length];
  }

  private draw(): void {
    const cv = this.canvas().nativeElement;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (ctx && w > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.paint(ctx, w, h, getComputedStyle(cv).color);
    }
    this.frame = requestAnimationFrame(() => this.draw());
  }

  private paint(ctx: CanvasRenderingContext2D, w: number, h: number, ink: string): void {
    const doc = this.doc();
    const now = this.karaoke.mediaMs();
    const lyricNow = now + doc.offset;
    const px = w / (BEHIND_MS + AHEAD_MS);
    const x = (t: number) => (t - lyricNow + BEHIND_MS) * px;
    const bar = h / 12;
    const y = (fold: number) => h - (fold + 0.5) * bar;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = ink;
    ctx.fillRect(BEHIND_MS * px - 1, 0, 2, h);
    ctx.globalAlpha = 0.7;
    for (const n of laneNotes(doc, lyricNow - BEHIND_MS, lyricNow + AHEAD_MS)) {
      ctx.fillStyle = n.golden ? '#facc15' : ink;
      ctx.beginPath();
      ctx.roundRect(x(n.start), y(n.fold) - bar * 0.35, Math.max(2, (n.end - n.start) * px), bar * 0.7, bar * 0.35);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const latency = this.karaoke.latencyMs();
    this.karaoke.store.singers().forEach((id, i) => {
      ctx.fillStyle = this.colour(i);
      const frames = this.karaoke.store.frames(id);
      for (let k = frames.length - 1; k >= 0; k--) {
        const f = frames[k];
        const t = f.t - latency + doc.offset;
        if (t < lyricNow - BEHIND_MS) break;
        if (f.midi === null || t > lyricNow) continue;
        ctx.beginPath();
        ctx.arc(x(t), y(foldPitch(f.midi)), bar * 0.22, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
  }

}
