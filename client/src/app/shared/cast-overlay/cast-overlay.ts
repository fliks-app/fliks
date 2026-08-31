import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { formatTime } from '../../core/utils/player.utils';
import { RemoteService } from '../../core/services/remote.service';
import { DeviceService } from '../../core/services/device.service';
import { CastPlaybackTarget } from '../../core/services/cast-playback-target';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { PlaybackOption } from '../../core/services/playback-target';
import { SeekbarComponent } from '../components/seekbar/seekbar';
import { CachedSrcDirective } from '../directives/cached-src.directive';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { DropdownOptionComponent } from '../components/dropdown-option/dropdown-option';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LucideCast,
  LucidePause,
  LucidePlay,
  LucideRotateCcw,
  LucideRotateCw,
  LucideSquare,
  LucideVolume2,
  LucideVolumeX,
  LucideX,
} from '@lucide/angular';

/**
 * The single playback-control surface: drives whichever target is active,
 * a Chromecast session or a remote target, through the same UI.
 */
@Component({
  selector: 'app-cast-overlay',
  imports: [
    LucideCast,
    LucidePause, LucidePlay, LucideRotateCcw, LucideRotateCw,
    LucideSquare, LucideVolume2, LucideVolumeX, LucideX,
    SeekbarComponent,
    CachedSrcDirective,
    ResolveUrlPipe,
    DropdownMenuComponent,
    DropdownOptionComponent,
    TranslateModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cast-overlay.html',
})
export class CastOverlayComponent {
  private readonly remote = inject(RemoteService);
  private readonly castTarget = inject(CastPlaybackTarget);
  private readonly remoteTarget = inject(RemotePlaybackTarget);

  get t() {
    return this.remote.isRemoting() ? this.remoteTarget : this.castTarget;
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.t.expanded()) this.t.expanded.set(false);
  }

  toggle() {
    this.t.expanded.update(v => !v);
  }

  private readonly translate = inject(TranslateService);
  protected readonly device = inject(DeviceService);

  readonly formatTime = formatTime;

  /** The trigger shows the current choice, like the media-detail selectors. */
  protected activeAudioLabel(): string {
    const id = this.t.activeAudioTrackId();
    const o = this.t.availableAudioTracks().find((x) => x.id === id);
    return o?.head || o?.label || '';
  }

  protected activeSubtitleLabel(): string {
    const id = this.t.activeSubtitleId();
    if (!id) return this.translate.instant('player.off');
    const o = this.t.availableSubtitles().find((x) => x.id === id);
    return o?.head || o?.label || '';
  }

  protected activeQualityLabel(): string {
    const id = this.t.activeQualityId();
    return this.t.availableQualities().find((o) => o.id === id)?.label ?? id;
  }

  selectSubtitle(sub: PlaybackOption | null) {
    this.t.selectSubtitle(sub);
  }

  selectAudio(track: PlaybackOption | null) {
    this.t.selectAudio(track);
  }

  selectQuality(quality: PlaybackOption) {
    this.t.selectQuality(quality);
  }

  stopPlayback() {
    this.t.stopPlayback();
  }

  disconnect() {
    this.t.disconnect();
  }
}
