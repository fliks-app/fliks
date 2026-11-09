import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { DeviceService } from '../../core/services/device.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { SessionSyncService, type AccountSession } from '../../core/services/session-sync.service';
import { SseService } from '../../core/services/sse.service';

/** Whether the strip of the account session played elsewhere shows on this device; the layout reads it to reserve room. */
@Injectable({ providedIn: 'root' })
export class SessionStripService {
  private readonly sync = inject(SessionSyncService);
  private readonly session = inject(PlaybackSession);
  private readonly device = inject(DeviceService);
  private readonly sse = inject(SseService);
  private readonly audio = inject(AudioPlayerService);

  /** Owner whose strip was hidden here: another owner, or no session in between, shows it again. Epochs restart after a deletion, so they are not compared. */
  private readonly hiddenOwner = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (!this.sync.session()) this.hiddenOwner.set(null);
    });
  }

  readonly observed = computed<AccountSession | null>(() => {
    const s = this.sync.session();
    if (!s || this.device.isTv() || !this.session.isLocal() || this.sync.role() !== 'observer') return null;
    if (this.sync.isReading(s) && s.owner.targetId === this.sse.targetId()) return null;
    return this.hiddenOwner() === s.owner.targetId && (!this.sync.parked() || this.sync.isReading(s)) ? null : s;
  });

  /** The strip rises above the audio mini-player, which sits at the same place. */
  readonly aboveAudio = computed(() => this.audio.active());

  hide(): void {
    const s = this.observed();
    if (!s) return;
    if (this.sync.parked() && !this.sync.isReading(s)) void this.sync.dismiss();
    else this.hiddenOwner.set(s.owner.targetId);
  }
}
