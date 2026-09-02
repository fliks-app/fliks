import { Injectable, computed, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { PlayerSettingsService } from './player-settings.service';
import { DisplaySettingsService } from './display-settings.service';
import { sortByLanguageName } from '../utils/language.utils';

/**
 * Read access to the client-local player preferences that surfaces needing a
 * subtitle-display flag depend on, without owning the settings page.
 */
@Injectable({ providedIn: 'root' })
export class AppSettingsService {
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly displaySettings = inject(DisplaySettingsService);
  private readonly translate = inject(TranslateService);

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

  /** Order the pickers by language name rather than by stream order. */
  readonly sortTracksByLanguage = computed(
    () => this.displaySettings.settings().sortTracksByLanguage,
  );

  /** A picker's rows in the order the viewer asked for. Call it from a
   *  computed: it reads the setting, so the list follows a toggle. */
  sortTracks<T extends { language?: string }>(items: readonly T[]): T[] {
    return this.sortTracksByLanguage()
      ? sortByLanguageName(items, this.translate)
      : [...items];
  }
}
