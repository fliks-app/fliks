import { Injectable, computed, inject } from '@angular/core';
import { PlayerSettingsService } from './player-settings.service';

/**
 * Read access to the client-local player preferences that surfaces needing a
 * subtitle-display flag depend on, without owning the settings page.
 */
@Injectable({ providedIn: 'root' })
export class AppSettingsService {
  private readonly playerSettings = inject(PlayerSettingsService);

  /**
   * Hide image-based (PGS/VOBSUB) subtitles from the pickers and native player.
   * A per-device client preference (image subs can't render as text — they need
   * burn-in or OCR).
   */
  readonly hideBurnInSubtitles = computed(
    () => this.playerSettings.settings().hideImageSubtitles,
  );

  /** Show the subtitle file format (SRT, VTT, ASS…) in the pickers. */
  readonly showSubtitleFormat = computed(
    () => this.playerSettings.settings().showSubtitleFormat,
  );
}
