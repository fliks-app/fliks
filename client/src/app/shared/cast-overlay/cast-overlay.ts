import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucidePause, LucidePlay, LucideX } from '@lucide/angular';
import { DeviceIconComponent } from '../device-chip/device-icon';
import { PlaybackDevice } from '../../core/services/playback-device.service';
import { DeviceService } from '../../core/services/device.service';
import { NowPlayingMetadataService } from '../../core/services/playback/now-playing-metadata.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemoteAudioOutput } from '../../core/services/audio-player/remote-audio-output';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { PlaybackSurface } from '../../core/services/playback/playback-surface';
import { SessionSyncService } from '../../core/services/session-sync.service';
import { KIND_REGISTRY } from '../../core/media-kinds';
import { formatTime } from '../../core/utils/player.utils';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../directives/cached-src.directive';
import { MarqueeComponent } from '../components/marquee';
import { SwipeTrackComponent } from '../audio-player/swipe-track';

/** Bar over the page while playback is on another device: the output this device sends to, else the account session it follows. The player route holds the full controls. */
@Component({
  selector: 'app-cast-overlay',
  imports: [NgTemplateOutlet, LucidePause, LucidePlay, LucideX, CachedSrcDirective, DeviceIconComponent, ResolveUrlPipe, TranslatePipe, MarqueeComponent, SwipeTrackComponent],
  templateUrl: './cast-overlay.html',
})
export class CastOverlayComponent {
  protected readonly session = inject(PlaybackSession);
  protected readonly sync = inject(SessionSyncService);
  private readonly target = inject(RemotePlaybackTarget);
  private readonly device = inject(DeviceService);
  protected readonly surface = inject(PlaybackSurface);
  protected readonly playing = inject(PlaybackDevice);

  protected readonly artwork = computed(() => {
    const meta = this.session.nowPlaying();
    return meta?.fanartUrl ?? meta?.posterUrl ?? null;
  });

  /** The cast or remote output; null on a TV, which never casts, and while playing locally. */
  protected readonly output = computed(() => (this.device.isTv() || this.session.isLocal() ? null : this.session.output()));

  protected readonly audioView = inject(RemoteAudioOutput);

  /** The account session played elsewhere that this device follows without having selected it. */
  protected readonly observed = this.surface.bar;

  /** The track of an observed album session, whose item title is the album and subtitle the track. */
  protected readonly observedTrack = inject(NowPlayingMetadataService).track(() => {
    const item = this.observed()?.item;
    return item?.kind === 'album' ? { mediaId: item.mediaId, episodeId: item.episodeId ?? undefined, itemId: item.id } : null;
  });

  /** An audio session's track, ahead of the owner's report after a skip sent from here. */
  private readonly audioTrack = computed(() => (this.audio() ? this.audioView.track() : null));

  protected readonly observedTitle = computed(() => {
    const item = this.observed()?.item;
    return this.audioTrack()?.title || this.observedTrack()?.title || (item?.kind === 'album' ? (item.subtitle ?? item.title ?? '') : (item?.title ?? ''));
  });
  protected readonly observedArtist = computed(() => this.audioTrack()?.artist ?? this.observedTrack()?.artist ?? '');
  protected readonly observedArtwork = computed(() => this.audioTrack()?.coverUrl ?? this.observed()?.item.posterUrl ?? null);

  /** The owner reports the file the session names: another file's report never drives this card. */
  protected readonly live = computed(() => this.observed() !== null && this.sync.liveReport() !== null);
  protected readonly paused = computed(() => (this.live() ? this.target.uiPaused() : !this.observed()?.playing));

  protected readonly clock = formatTime;

  /** An audio session reads its view, which follows a skip sent from here before the owner reports it. */
  protected readonly time = computed(() => {
    const s = this.observed();
    if (!s) return '';
    return formatTime(this.audio() ? this.audioView.position() : this.sync.positionNow(s));
  });

  protected readonly percent = computed(() => {
    const s = this.observed();
    if (!s) return 0;
    const [pos, dur] = this.audio() ? [this.audioView.position(), this.audioView.duration()] : [this.sync.positionNow(s), this.sync.durationNow(s)];
    return dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  });

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

  /** Read from the session too: the owner may not have reported since this device started following it. */
  protected toggleObserved(): void {
    if (this.paused()) this.target.play();
    else void this.target.pause();
  }
}
