import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideArrowRightLeft, LucidePause, LucidePlay, LucideX } from '@lucide/angular';
import { DeviceService } from '../../core/services/device.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemoteAudioOutput } from '../../core/services/audio-player/remote-audio-output';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { SessionStripService } from './session-strip.service';
import { SessionSyncService } from '../../core/services/session-sync.service';
import { KIND_REGISTRY } from '../../core/media-kinds';
import { formatTime } from '../../core/utils/player.utils';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { RemotePickerListComponent } from '../remote-picker/remote-picker-list';
import { CachedSrcDirective } from '../directives/cached-src.directive';

/** Bar over the page while playback is on another device: the output this device sends to, else the account session it follows. The player route holds the full controls. */
@Component({
  selector: 'app-cast-overlay',
  imports: [NgTemplateOutlet, LucideArrowRightLeft, LucidePause, LucidePlay, LucideX, DropdownMenuComponent, RemotePickerListComponent, CachedSrcDirective, ResolveUrlPipe, TranslatePipe],
  templateUrl: './cast-overlay.html',
})
export class CastOverlayComponent {
  protected readonly session = inject(PlaybackSession);
  protected readonly sync = inject(SessionSyncService);
  private readonly target = inject(RemotePlaybackTarget);
  private readonly device = inject(DeviceService);
  protected readonly strip = inject(SessionStripService);
  private readonly transferList = viewChild(RemotePickerListComponent);

  protected readonly artwork = computed(() => {
    const meta = this.session.nowPlaying();
    return meta?.fanartUrl ?? meta?.posterUrl ?? this.sync.session()?.item.posterUrl ?? null;
  });

  /** The cast or remote output; null on a TV, which never casts, and while playing locally. */
  protected readonly output = computed(() => (this.device.isTv() || this.session.isLocal() ? null : this.session.output()));

  /** The account session played elsewhere that this device follows without having selected it. */
  protected readonly observed = this.strip.observed;

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
  /** The owner answers commands while it plays, whether or not its report has arrived. */
  protected readonly controllable = computed(() => this.observed() !== null && !this.sync.parked());
  protected readonly paused = computed(() => (this.live() ? this.target.uiPaused() : !this.observed()?.playing));

  protected readonly detail = computed(() => {
    const s = this.observed();
    if (!s) return '';
    const pos = this.live() ? this.target.position() : this.sync.positionNow(s);
    const dur = this.live() ? this.target.duration() : (s.durationSeconds ?? 0);
    const time = dur > 0 ? `${formatTime(pos)} / ${formatTime(dur)}` : formatTime(pos);
    return `${time} · ${this.sync.ownerName(s)}`;
  });

  protected readonly percent = computed(() => {
    const s = this.observed();
    if (!s) return 0;
    const dur = this.live() ? this.target.duration() : (s.durationSeconds ?? 0);
    const pos = this.live() ? this.target.position() : this.sync.positionNow(s);
    return dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  });

  private readonly audioView = inject(RemoteAudioOutput);

  /** An audio session has a full controller: transport, queue, take over. */
  protected readonly audio = computed(() => {
    const item = this.observed()?.item;
    if (!item) return false;
    if (item.family) return item.family === 'audio';
    const families = KIND_REGISTRY[item.kind].families;
    return families.includes('audio') && !families.includes('video');
  });

  protected openAudio(): void {
    this.audioView.expand();
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
    this.strip.hide();
  }

  /** The projected list is refreshed on every press of the trigger, as the top-bar picker does. */
  protected refreshTransfer(): void {
    this.transferList()?.refresh();
  }
}
