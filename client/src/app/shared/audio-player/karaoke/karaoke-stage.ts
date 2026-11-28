import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, linkedSignal, output, signal, untracked, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../icons';
import type { AudioOutput } from '../../../core/services/audio-player/audio-output';
import type { StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { GUIDE_VOCAL_LEVEL, type StemMode } from '../../../core/services/audio-player/stem-mix';
import { DeviceService } from '../../../core/services/device.service';
import { KaraokeRelayService } from '../../../core/services/karaoke/karaoke-relay.service';
import { KaraokeService, type BoardRow } from '../../../core/services/karaoke/karaoke.service';
import { intoRange, laneNotes, laneRange } from '../../../core/services/karaoke/pitch-lane';
import { TOLERANCE, foldedDistance, type Difficulty } from '../../../core/services/karaoke/karaoke-score';
import { GOLD, SINGER_COLOURS, singerStyle } from '../../../core/services/karaoke/singer-style';
import { PartyService } from '../../../core/services/party/party.service';
import { sameItem } from '../../../core/services/party/party-item';
import { TvSectionDirective } from '../../directives/tv-section.directive';
import { CdgCanvasComponent } from '../cdg/cdg-canvas';
import { LyricsViewComponent } from '../lyrics/lyrics-view';

const BEHIND_MS = 2000;
const AHEAD_MS = 6000;
const RESULTS_MS = 500;
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
const MODES: StemMode[] = ['instrumental', 'guide', 'original'];
/** Guide never reaches the ends: 0 is Instrumental and 1 is Original. */
const GUIDE_MIN = 0.05;
const MIX_KEY = 'fliks.karaoke.mix';
/** Taps on the key buttons gather this long before the track reopens in the new key. */
const KEY_SETTLE_MS = 600;
const UP_NEXT = 3;

interface SavedMix {
  mode: StemMode;
  guide: number;
}

function readMix(): SavedMix | null {
  try {
    const m = JSON.parse(localStorage.getItem(MIX_KEY) ?? 'null') as Partial<SavedMix> | null;
    const ok = !!m && MODES.includes(m.mode as StemMode) && typeof m.guide === 'number' && m.guide >= GUIDE_MIN && m.guide <= 1 - GUIDE_MIN;
    return ok ? (m as SavedMix) : null;
  } catch {
    return null;
  }
}

/** The karaoke view: lyrics with word fill, the reference melody as a pitch lane, live scores, the mix bar and the settings. */
@Component({
  selector: 'app-karaoke-stage',
  imports: [NgTemplateOutlet, TranslatePipe, TvSectionDirective, LyricsViewComponent, CdgCanvasComponent, LucideDynamicIcon],
  templateUrl: './karaoke-stage.html',
})
export class KaraokeStageComponent {
  protected readonly icons = icons;

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

  readonly doc = input.required<StructuredLyrics>();
  /** Another device's session the stage follows; the local player when absent. */
  readonly output = input<AudioOutput | null>(null);
  readonly title = input('');
  /** Shows the recompute actions (with `media.edit`). */
  readonly canEdit = input(false);
  readonly busy = input(false);
  /** A failed lyrics step of the preparation, already worded. */
  readonly error = input('');
  /** A tap on a line seeks; never in a party, where it would move everyone. */
  readonly seekable = input(true);
  /** The MP3+G graphics drawn above the lyrics. */
  readonly cdgFile = input<number | null>(null);
  readonly recompute = output<'sync' | 'melody'>();
  /** Drops the track's stems and generated lyrics (with `canEdit`). */
  readonly remove = output<void>();

  protected get audio(): AudioOutput {
    return this.output() ?? this.local;
  }
  protected readonly stemMode = computed(() => this.audio.stemMode?.() ?? 'original');
  protected readonly stemsAvailable = computed(() => this.audio.stemsAvailable?.() ?? false);
  protected readonly pitch = computed(() => this.audio.pitch?.() ?? 0);
  /** The key the taps aim at, shown at once; the output follows once they settle. */
  protected readonly targetKey = linkedSignal(() => this.pitch());
  private keyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Why the key cannot change here, or null. */
  protected readonly keyBlocked = computed(() => {
    if (this.karaoke.status() && !this.karaoke.status()!.pitchShift) return 'karaoke.key_unavailable';
    return this.audio.canShiftKey && !this.audio.canShiftKey() ? 'karaoke.key_not_here' : null;
  });
  protected readonly hasLines = computed(() => this.doc().line.length > 0);
  protected readonly lineSeek = computed(() => this.seekable() && !this.party.active());
  /** The next programme rows with their singers, on the party's display. */
  protected readonly upNext = computed(() => {
    if (!this.party.active() || !this.party.isHost()) return [];
    const rows = this.party.programme();
    const now = this.party.item();
    const at = now ? rows.findIndex((r) => sameItem(r, now)) : -1;
    return rows
      .slice(at + 1)
      .filter((r) => !r.hidden)
      .slice(0, UP_NEXT)
      .map((r) => ({ title: r.title, singer: this.party.userName(r.addedBy) }));
  });

  protected readonly difficulties = DIFFICULTIES;
  protected readonly modes = MODES;
  /** The last guide level, restored when Guide is selected again. */
  private readonly saved = readMix();
  /** Follows the level the output plays at; off Guide it keeps the last one. */
  protected readonly guideLevel = linkedSignal<number, number>({
    source: () => this.audio.vocalLevel?.() ?? 0,
    computation: (v, prev) => (v > 0 && v < 1 ? v : (prev?.value ?? this.saved?.guide ?? GUIDE_VOCAL_LEVEL)),
  });
  /** The slider rests at 0 on Instrumental and 100 on Original, and shows the guide level on Guide. */
  protected readonly sliderValue = computed(() => {
    const mode = this.stemMode();
    return mode === 'instrumental' ? 0 : mode === 'original' ? 100 : this.guideLevel() * 100;
  });
  protected readonly rows = signal<BoardRow[]>([]);
  protected readonly calibrated = signal<boolean | null>(null);
  private readonly range = computed(() => laneRange(this.doc(), this.pitch()));
  protected readonly hasMelody = computed(() => (this.doc().cueLine ?? []).some((l) => l.cue.some((c) => c.pitch !== undefined)));
  protected readonly canSing = this.karaoke.canSing;

  protected readonly status = computed(() => {
    const issue = this.karaoke.micIssue();
    if (issue) return { error: true, text: this.translate.instant(`karaoke.mic_${issue}`) };
    if (this.error()) return { error: true, text: this.error() };
    if (!this.hasMelody()) return { error: false, text: this.translate.instant('karaoke.no_melody') };
    if (!this.canSing && this.party.active()) return { error: false, text: this.translate.instant('karaoke.phones_hint') };
    return null;
  });

  private frame = 0;
  /** Read off the frame loop: a per-frame read forces a style and layout pass on slow TVs. */
  private size = { w: 0, h: 0 };
  private colours = { ink: '', primary: '' };

  constructor() {
    const destroyRef = inject(DestroyRef);
    const timer = setInterval(() => this.refresh(), RESULTS_MS);
    let restored = false;
    effect(() => {
      if (restored || !this.stemsAvailable()) return;
      restored = true;
      // The preset is this browser's, Instrumental the first time; another device's session keeps its own mix.
      if (!this.output()) untracked(() => this.setMode(this.saved?.mode ?? 'instrumental'));
    });
    afterNextRender(() => {
      const ro = new ResizeObserver(([e]) => {
        this.size = { w: e.contentRect.width, h: e.contentRect.height };
        this.readColours();
        this.redraw();
      });
      ro.observe(this.canvas().nativeElement);
      destroyRef.onDestroy(() => ro.disconnect());
    });
    destroyRef.onDestroy(() => {
      clearInterval(timer);
      if (this.keyTimer) clearTimeout(this.keyTimer);
      cancelAnimationFrame(this.frame);
      this.relay.close('display');
    });
    effect(() => {
      if (this.party.active() && this.party.isHost()) untracked(() => this.relay.open('display'));
    });
    effect(() => {
      const board = this.karaoke.board();
      const el = this.dialog()?.nativeElement;
      if (board && el && !el.open) el.showModal();
      if (!board && el?.open) el.close();
    });
    effect(() => {
      this.doc();
      this.audio.playing();
      this.audio.position();
      untracked(() => this.redraw());
    });
  }

  private readColours(): void {
    this.colours = { ink: getComputedStyle(this.canvas().nativeElement).color, primary: getComputedStyle(this.primary().nativeElement).color };
  }

  private refresh(): void {
    this.readColours();
    if (!this.audio.playing()) this.redraw();
    this.rows.set(this.karaoke.results(this.doc()));
    const dur = this.audio.duration();
    if (dur > 0 && this.audio.position() >= dur - 1.5) this.karaoke.finish(this.doc(), this.title());
  }

  protected setMode(mode: StemMode): void {
    // Read first: entering a stem mode resets the output's level, which the guide level follows.
    const level = this.guideLevel();
    this.audio.setStemMode?.(mode);
    if (mode === 'guide') this.audio.setVocalLevel?.(level);
    this.remember(mode);
  }

  /** The preset lives in this browser, so the next track and the next visit start on it. */
  private remember(mode: StemMode): void {
    try {
      localStorage.setItem(MIX_KEY, JSON.stringify({ mode, guide: this.guideLevel() } satisfies SavedMix));
    } catch {
      /* storage unavailable: the choice lasts for the session */
    }
  }

  /** Moving the slider selects Guide at that level. */
  protected setGuide(level: number): void {
    const guide = Math.min(Math.max(level, GUIDE_MIN), 1 - GUIDE_MIN);
    this.guideLevel.set(guide);
    this.audio.setStemMode?.('guide');
    this.audio.setVocalLevel?.(guide);
    this.remember('guide');
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
    this.targetKey.set(delta === 0 ? 0 : Math.min(12, Math.max(-12, this.targetKey() + delta)));
    if (this.keyTimer) clearTimeout(this.keyTimer);
    this.keyTimer = setTimeout(() => {
      this.keyTimer = null;
      if (this.targetKey() !== this.pitch()) void this.audio.setPitch?.(this.targetKey());
    }, KEY_SETTLE_MS);
  }

  protected closeBoard(): void {
    this.dialog()?.nativeElement.close();
  }

  /** The singer's palette entry: their side's in a duet, else the n-th colour. */
  protected singer(agentId: string | null, i: number) {
    const st = agentId ? singerStyle(this.doc(), agentId) : null;
    return { colour: st?.colour ?? SINGER_COLOURS[i % SINGER_COLOURS.length], mark: st?.mark ?? '', name: st?.name ?? '', n: st?.n ?? 0 };
  }

  private redraw(): void {
    cancelAnimationFrame(this.frame);
    this.draw();
  }

  /** Animates only while the track plays; a pause, seek or resize paints once through `redraw`. */
  private draw(): void {
    const cv = this.canvas().nativeElement;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.size;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (ctx && w > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.paint(ctx, w, h, this.colours.ink, this.colours.primary);
    }
    if (this.audio.playing()) this.frame = requestAnimationFrame(() => this.draw());
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
    const tol = TOLERANCE[this.karaoke.difficulty()];
    this.karaoke.store.singers().forEach((id, i) => {
      ctx.fillStyle = this.singer(null, i).colour;
      const frames = this.karaoke.store.frames(id);
      for (let k = frames.length - 1; k >= 0; k--) {
        const f = frames[k];
        const t = f.t + doc.offset;
        if (t < lyricNow - BEHIND_MS) break;
        if (f.midi === null || t > lyricNow) continue;
        const ref = notes.find((n) => n.start <= t && t < n.end);
        const hit = !!ref && foldedDistance(f.midi, ref.midi) <= tol;
        ctx.globalAlpha = hit ? 1 : 0.5;
        ctx.beginPath();
        ctx.arc(x(t), y(intoRange(f.midi, this.range(), ref?.midi ?? (lo + hi) / 2)), bar * (hit ? 0.3 : 0.2), 0, 2 * Math.PI);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
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
