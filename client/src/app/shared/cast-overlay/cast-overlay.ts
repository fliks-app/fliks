import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { formatTime } from '../../core/utils/player.utils';
import { RemoteService } from '../../core/services/remote.service';
import { CastPlaybackTarget } from '../../core/services/cast-playback-target';
import { RemotePlaybackTarget } from '../../core/services/remote-playback-target';
import { PlaybackOption } from '../../core/services/playback-target';
import { SeekbarComponent } from '../components/seekbar/seekbar';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { TranslateModule } from '@ngx-translate/core';
import {
  LucideCaptions,
  LucideCast,
  LucideCheck,
  LucideHeadphones,
  LucidePause,
  LucidePlay,
  LucideRotateCcw,
  LucideRotateCw,
  LucideSettings,
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
    LucideCaptions, LucideCast, LucideCheck,
    LucideHeadphones, LucidePause, LucidePlay, LucideRotateCcw, LucideRotateCw,
    LucideSettings, LucideSquare, LucideVolume2, LucideVolumeX, LucideX,
    SeekbarComponent,
    DropdownMenuComponent,
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

  readonly formatTime = formatTime;

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
