import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
} from '@angular/core';
import { formatTime } from '../../core/utils/player.utils';
import { RemoteService } from '../../core/services/remote.service';
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

/** One labelled track/quality picker in the control row. */
interface PickerRow {
  kind: 'audio' | 'subtitle' | 'quality';
  labelKey: string;
  /** What the trigger shows, like the media-detail selectors. */
  active: string;
  options: PlaybackOption[];
  activeId: string | null;
  /** Subtitles alone offer an explicit "off" row above the list. */
  offRow: boolean;
}

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

  /** Built as data rather than three near-identical template blocks: a file
   *  with one audio track must leave no hole, and each panel's anchor has to
   *  follow the position the picker actually ends up in. */
  protected readonly pickers = computed<PickerRow[]>(() => {
    const t = this.t;
    const rows: PickerRow[] = [];
    if (t.availableAudioTracks().length > 1) {
      rows.push({
        kind: 'audio',
        labelKey: 'player.audio',
        active: this.activeAudioLabel(),
        options: t.availableAudioTracks(),
        activeId: t.activeAudioTrackId(),
        offRow: false,
      });
    }
    if (t.availableSubtitles().length) {
      rows.push({
        kind: 'subtitle',
        labelKey: 'player.subtitles',
        active: this.activeSubtitleLabel(),
        options: t.availableSubtitles(),
        activeId: t.activeSubtitleId(),
        offRow: true,
      });
    }
    if (t.availableQualities().length > 1) {
      rows.push({
        kind: 'quality',
        labelKey: 'player.quality',
        active: this.activeQualityLabel(),
        options: t.availableQualities(),
        activeId: t.activeQualityId(),
        offRow: false,
      });
    }
    return rows;
  });

  /** Only the rightmost list opens leftwards: the panel has a 240px floor, so
   *  anchoring it the other way pushed it outside the card. */
  protected placementFor(index: number): 'top-start' | 'top-end' {
    return index === this.pickers().length - 1 ? 'top-end' : 'top-start';
  }

  protected pick(row: PickerRow, option: PlaybackOption | null) {
    if (row.kind === 'audio') this.t.selectAudio(option);
    else if (row.kind === 'subtitle') this.t.selectSubtitle(option);
    else if (option) this.t.selectQuality(option);
  }

  stopPlayback() {
    this.t.stopPlayback();
  }

  disconnect() {
    this.t.disconnect();
  }
}
