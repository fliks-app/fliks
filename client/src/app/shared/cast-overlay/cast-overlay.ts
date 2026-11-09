import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideArrowRightLeft, LucidePause, LucidePlay, LucideX } from '@lucide/angular';
import { DeviceService } from '../../core/services/device.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { SseService } from '../../core/services/sse.service';
import { SessionSyncService } from '../../core/services/session-sync.service';
import { KIND_REGISTRY } from '../../core/media-kinds';
import { formatTime } from '../../core/utils/player.utils';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { RemotePickerListComponent } from '../remote-picker/remote-picker-list';
import { SessionAudioControllerComponent } from './session-audio-controller';
import { CachedSrcDirective } from '../directives/cached-src.directive';

/** Bar over the page while playback is on another device: the output this device sends to, else the account session it follows. The player route holds the full controls. */
@Component({
  selector: 'app-cast-overlay',
  imports: [NgTemplateOutlet, LucideArrowRightLeft, LucidePause, LucidePlay, LucideX, DropdownMenuComponent, RemotePickerListComponent, CachedSrcDirective, SessionAudioControllerComponent, ResolveUrlPipe, TranslatePipe],
  templateUrl: './cast-overlay.html',
})
export class CastOverlayComponent {
  protected readonly session = inject(PlaybackSession);
  protected readonly sync = inject(SessionSyncService);
  private readonly target = inject(RemotePlaybackTarget);
  private readonly device = inject(DeviceService);
  private readonly sse = inject(SseService);

  /** Owner whose strip was hidden here: another owner, or no session in between, shows it again. Epochs restart after a deletion, so they are not compared. */
  private readonly hiddenOwner = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (!this.sync.session()) this.hiddenOwner.set(null);
    });
  }

  protected readonly artwork = computed(() => {
    const meta = this.session.nowPlaying();
    return meta?.fanartUrl ?? meta?.posterUrl ?? this.sync.session()?.item.posterUrl ?? null;
  });

  /** The cast or remote output; null on a TV, which never casts, and while playing locally. */
  protected readonly output = computed(() => (this.device.isTv() || this.session.isLocal() ? null : this.session.output()));

  /** The account session played elsewhere that this device follows without having selected it. */
  protected readonly observed = computed(() => {
    const s = this.sync.session();
    if (!s || this.device.isTv() || !this.session.isLocal() || this.sync.role() !== 'observer') return null;
    if (this.sync.isReading(s) && s.owner.targetId === this.sse.targetId()) return null;
    return this.hiddenOwner() === s.owner.targetId && !this.sync.parked() ? null : s;
  });

  /** A reader's position: read elsewhere, opened here, with a percentage instead of a clock. */
  protected readonly reading = computed(() => {
    const s = this.observed();
    return !!s && this.sync.isReading(s);
  });

  protected readonly readPercent = computed(() => {
    const s = this.observed();
    return s ? Math.round(Math.min(1, s.positionSeconds / (s.durationSeconds || 1)) * 100) : 0;
  });

  protected readonly live = computed(() => this.observed() !== null && !this.sync.parked() && !this.target.isIdle());
  protected readonly paused = computed(() => this.target.uiPaused());

  protected readonly detail = computed(() => {
    const s = this.observed();
    if (!s) return '';
    const device = s.owner.deviceName ?? '';
    const pos = this.live() ? this.target.position() : s.positionSeconds;
    const dur = this.live() ? this.target.duration() : (s.durationSeconds ?? 0);
    const time = dur > 0 ? `${formatTime(pos)} / ${formatTime(dur)}` : formatTime(pos);
    return `${device} · ${time}`;
  });

  private readonly controller = viewChild(SessionAudioControllerComponent);

  /** An audio session has a full controller: transport, queue, take over. */
  protected readonly audio = computed(() => {
    const item = this.observed()?.item;
    if (!item) return false;
    if (item.family) return item.family === 'audio';
    const families = KIND_REGISTRY[item.kind].families;
    return families.includes('audio') && !families.includes('video');
  });

  protected openController(): void {
    this.controller()?.open();
  }

  protected open(): void {
    this.session.openPlayer();
  }

  protected togglePlay(): void {
    this.session.command({ type: 'toggle' });
  }

  protected toggleObserved(): void {
    this.target.togglePlayPause();
  }

  protected hide(): void {
    const s = this.observed();
    if (!s) return;
    if (this.sync.parked()) void this.sync.dismiss();
    else this.hiddenOwner.set(s.owner.targetId);
  }
}
