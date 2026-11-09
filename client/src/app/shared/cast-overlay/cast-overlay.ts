import { Component, computed, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucidePause, LucidePlay, LucideX } from '@lucide/angular';
import { DeviceService } from '../../core/services/device.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { SessionSyncService } from '../../core/services/session-sync.service';
import { formatTime } from '../../core/utils/player.utils';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../directives/cached-src.directive';

/** Bar over the page while playback is on another device: the output this device sends to, else the account session it follows. The player route holds the full controls. */
@Component({
  selector: 'app-cast-overlay',
  imports: [LucidePause, LucidePlay, LucideX, CachedSrcDirective, ResolveUrlPipe, TranslatePipe],
  templateUrl: './cast-overlay.html',
})
export class CastOverlayComponent {
  protected readonly session = inject(PlaybackSession);
  protected readonly sync = inject(SessionSyncService);
  private readonly target = inject(RemotePlaybackTarget);
  private readonly device = inject(DeviceService);

  /** Epoch whose strip was hidden here: a new owner shows it again. */
  private readonly hiddenEpoch = signal<number | null>(null);

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
    return this.hiddenEpoch() === s.epoch && !this.sync.parked() ? null : s;
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
    else this.hiddenEpoch.set(s.epoch);
  }
}
