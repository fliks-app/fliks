import { Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideListMusic, LucideMic, LucideMinus, LucidePlus, LucideSlidersHorizontal, LucideX } from '@lucide/angular';
import type { AudioOutput } from '../../../core/services/audio-player/audio-output';
import type { StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { DeviceService } from '../../../core/services/device.service';
import { KaraokeRelayService } from '../../../core/services/karaoke/karaoke-relay.service';
import { KaraokeService, type BoardRow } from '../../../core/services/karaoke/karaoke.service';
import { singerName } from '../../../core/services/karaoke/singer-name';
import { intoRange, laneNotes, laneRange } from '../../../core/services/karaoke/pitch-lane';
import type { Difficulty } from '../../../core/services/karaoke/karaoke-score';
import { GOLD, SINGER_COLOURS, singerStyle } from '../../../core/services/karaoke/singer-style';
import { PartyService } from '../../../core/services/party/party.service';
import { TvSectionDirective } from '../../directives/tv-section.directive';
import { LyricsViewComponent } from '../lyrics/lyrics-view';
import { KaraokeQueueComponent } from './karaoke-queue';

const BEHIND_MS = 2000;
const AHEAD_MS = 6000;
const RESULTS_MS = 500;
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
const LEVEL_STEP = 10;
const LEVEL_KEY = 'fliks.karaoke.level';

function readLevel(): number | null {
  try {
    const v = Number(localStorage.getItem(LEVEL_KEY));
    return localStorage.getItem(LEVEL_KEY) !== null && v >= 0 && v <= 100 ? v : null;
  } catch {
    return null;
  }
}

/** The karaoke view: lyrics with word fill, the reference melody as a pitch lane, live scores, the voice level and the settings. */
@Component({
  selector: 'app-karaoke-stage',
  imports: [TranslatePipe, TvSectionDirective, LyricsViewComponent, KaraokeQueueComponent, LucideListMusic, LucideMic, LucideMinus, LucidePlus, LucideSlidersHorizontal, LucideX],
  templateUrl: './karaoke-stage.html',
})
export class KaraokeStageComponent {
  protected readonly karaoke = inject(KaraokeService);
  private readonly local = inject(AudioPlayerService);
  private readonly device = inject(DeviceService);
  protected readonly tv = this.device.isTv;
  /** Settings open as a bottom sheet on touch and TV, a side panel elsewhere. */
  protected readonly sheet = computed(() => this.device.isTouch() || this.device.isTv());
  private readonly translate = inject(TranslateService);
  private readonly relay = inject(KaraokeRelayService);
  private readonly party = inject(PartyService);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('lane');
  private readonly primary = viewChild.required<ElementRef<HTMLElement>>('primary');
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('board');
  private readonly settings = viewChild.required<ElementRef<HTMLDialogElement>>('settings');
  private readonly queueDialog = viewChild<ElementRef<HTMLDialogElement>>('queueSheet');

  readonly doc = input.required<StructuredLyrics>();
  /** Another device's session the stage follows; the local player when absent. */
  readonly output = input<AudioOutput | null>(null);
  readonly title = input('');
  /** Shows the recompute actions (with `media.edit`). */
  readonly canEdit = input(false);
  readonly busy = input(false);
  /** A failed lyrics step of the preparation, already worded. */
  readonly error = input('');
  readonly recompute = output<'sync' | 'melody'>();

  protected get audio(): AudioOutput {
    return this.output() ?? this.local;
  }
  protected readonly stemMode = computed(() => this.audio.stemMode?.() ?? 'original');
  protected readonly stemsAvailable = computed(() => this.audio.stemsAvailable?.() ?? false);
  protected readonly pitch = computed(() => this.audio.pitch?.() ?? 0);

  protected readonly difficulties = DIFFICULTIES;
  /** The voice level in percent: 100 is the original mix, 0 the instrumental. */
  protected readonly level = computed(() => (this.stemMode() === 'original' ? 100 : Math.round((this.audio.vocalLevel?.() ?? 0) * 100)));
  protected readonly step = LEVEL_STEP;
  private readonly saved = readLevel();
  protected readonly next = computed(() => this.party.singerQueue()[0] ?? null);
  protected readonly rows = signal<BoardRow[]>([]);
  protected readonly calibrated = signal<boolean | null>(null);
  private readonly range = computed(() => laneRange(this.doc(), this.pitch()));
  protected readonly hasMelody = computed(() => (this.doc().cueLine ?? []).some((l) => l.cue.some((c) => c.pitch !== undefined)));
  protected readonly canSing = this.karaoke.canSing;
  protected readonly inParty = this.party.active;

  protected readonly status = computed(() => {
    const issue = this.karaoke.micIssue();
    if (issue) return { error: true, text: this.translate.instant(`karaoke.mic_${issue}`) };
    if (this.error()) return { error: true, text: this.error() };
    if (!this.hasMelody()) return { error: false, text: this.translate.instant('karaoke.no_melody') };
    if (!this.canSing && this.rows().length === 0) return { error: false, text: this.translate.instant('karaoke.phones_hint') };
    return null;
  });

  private frame = 0;

  constructor() {
    const destroyRef = inject(DestroyRef);
    const timer = setInterval(() => this.refresh(), RESULTS_MS);
    let restored = this.saved === null;
    effect(() => {
      if (restored || !this.stemsAvailable()) return;
      restored = true;
      untracked(() => this.setLevel(this.saved!));
    });
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

  /** One slider: 100 plays the original mix, anything below plays the stems with that much voice. */
  protected setLevel(percent: number): void {
    const v = Math.min(100, Math.max(0, percent));
    if (v === 100) this.audio.setStemMode?.('original');
    else {
      if (this.stemMode() === 'original') this.audio.setStemMode?.('guide');
      this.audio.setVocalLevel?.(v / 100);
    }
    try {
      localStorage.setItem(LEVEL_KEY, String(v));
    } catch {
      /* storage unavailable: the choice lasts for the session */
    }
  }

  protected name(userId: number): string {
    return singerName(this.party, userId);
  }

  protected openQueue(): void {
    this.queueDialog()?.nativeElement.showModal();
  }

  protected closeQueue(): void {
    this.queueDialog()?.nativeElement.close();
  }

  protected openSettings(): void {
    this.settings().nativeElement.showModal();
  }

  protected closeSettings(): void {
    this.settings().nativeElement.close();
  }

  protected toggleSinging(): void {
    if (this.karaoke.singing()) this.karaoke.stopSinging();
    else void this.karaoke.startSinging();
  }

  protected calibrate(): void {
    this.calibrated.set(this.karaoke.calibrate(this.doc()));
  }

  protected setPitch(delta: number): void {
    void this.audio.setPitch?.(delta === 0 ? 0 : this.pitch() + delta);
  }

  protected closeBoard(): void {
    this.dialog()?.nativeElement.close();
  }

  /** The singer's palette entry: their side's in a duet, else the n-th colour. */
  protected singer(agentId: string | null, i: number) {
    const st = agentId ? singerStyle(this.doc(), agentId) : null;
    return { colour: st?.colour ?? SINGER_COLOURS[i % SINGER_COLOURS.length], mark: st?.mark ?? '', name: st?.name ?? '', n: st?.n ?? 0 };
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
      this.paint(ctx, w, h, getComputedStyle(cv).color, getComputedStyle(this.primary().nativeElement).color);
    }
    this.frame = requestAnimationFrame(() => this.draw());
  }

  private paint(ctx: CanvasRenderingContext2D, w: number, h: number, ink: string, primary: string): void {
    const doc = this.doc();
    const now = this.karaoke.mediaMs();
    const lyricNow = now + doc.offset;
    const px = w / (BEHIND_MS + AHEAD_MS);
    const x = (t: number) => (t - lyricNow + BEHIND_MS) * px;
    const { lo, hi } = this.range();
    const bar = h / (hi - lo + 1);
    const y = (midi: number) => h - (midi - lo + 0.5) * bar;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = ink;
    ctx.fillRect(BEHIND_MS * px - 1, 0, 2, h);
    ctx.globalAlpha = 0.7;
    const notes = laneNotes(doc, lyricNow - BEHIND_MS, lyricNow + AHEAD_MS, this.range(), this.pitch());
    for (const n of notes) {
      const st = singerStyle(doc, n.agentId);
      const colour = st?.colour ?? (n.start <= lyricNow && lyricNow < n.end ? primary : ink);
      const [bx, by, bw, bh] = [x(n.start), y(n.midi) - bar * 0.35, Math.max(2, (n.end - n.start) * px), bar * 0.7];
      ctx.fillStyle = colour;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, bar * 0.35);
      if (st?.shape !== 'outlined') ctx.fill();
      if (st?.shape === 'outlined') ctx.stroke();
      if (st?.shape === 'both') this.hatch(ctx, bx, by, bw, bh);
      if (n.golden) {
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(bx - 2, by - 2, bw + 4, bh + 4, bar * 0.35 + 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    const latency = this.karaoke.latencyMs();
    this.karaoke.store.singers().forEach((id, i) => {
      ctx.fillStyle = this.singer(null, i).colour;
      const frames = this.karaoke.store.frames(id);
      for (let k = frames.length - 1; k >= 0; k--) {
        const f = frames[k];
        const t = f.t - latency + doc.offset;
        if (t < lyricNow - BEHIND_MS) break;
        if (f.midi === null || t > lyricNow) continue;
        ctx.beginPath();
        const ref = notes.find((n) => n.start <= t && t < n.end);
        ctx.arc(x(t), y(intoRange(f.midi, this.range(), ref?.midi ?? (lo + hi) / 2)), bar * 0.22, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
  }

  /** Cuts diagonal stripes out of the path just filled, so a group note differs by shape from a singer's. */
  private hatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    ctx.save();
    ctx.clip();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = 2;
    for (let k = -h; k < w; k += 6) {
      ctx.beginPath();
      ctx.moveTo(x + k, y + h);
      ctx.lineTo(x + k + h, y);
      ctx.stroke();
    }
    ctx.restore();
  }
}
