import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { formatTime, parseAudioIndex } from '../../core/utils/player.utils';
import { CastService } from '../../core/services/cast.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
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
  readonly cast = inject(CastService);
  readonly cp = inject(CastPlayerService);

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.cp.expanded()) this.cp.expanded.set(false);
  }

  toggle() {
    this.cp.expanded.update(v => !v);
  }

  readonly formatTime = formatTime;

  selectSubtitle(sub: any | null) {
    if (!sub) {
      this.cp.activeSubtitleId.set(null);
      this.cast.setActiveSubtitle(0);
      this.cp.changeBurnIn(null);
      this.cp.saveSubtitleSelection(null);
      return;
    }
    this.cp.activeSubtitleId.set(sub.id);
    this.cp.saveSubtitleSelection(sub.language, sub.forced);
    if (sub.burnIn) {
      this.cp.changeBurnIn(sub.castTrackId ?? 0);
    } else if (sub.castTrackId) {
      this.cast.setActiveSubtitle(sub.castTrackId);
    }
  }

  selectAudio(track: any | null) {
    if (!track) return;
    this.cp.activeAudioTrackId.set(track.id);
    this.cp.changeAudio(parseAudioIndex(track.id));
  }

  selectQuality(quality: any) {
    if (quality.id === this.cp.activeQualityId()) return;
    this.cp.changeQuality(quality.id);
  }

  disconnect() {
    this.cast.stop();
    this.cp.clear();
    this.cp.expanded.set(false);
  }

}
