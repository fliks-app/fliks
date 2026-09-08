import { Component, inject, signal } from '@angular/core';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PlayerSettingsService } from '../../../core/services/player-settings.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import { persistOnChange } from '../../../core/utils/persist-on-change';
import { LucideTrash2 } from '@lucide/angular';
import { SubtitleAppearanceComponent } from '../../../shared/components/subtitle-appearance/subtitle-appearance';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import {
  LANGUAGE_OPTIONS, SUBTITLE_MODE_OPTIONS, SUBTITLE_HI_OPTIONS,
  BOTTOM_MARGIN_OPTIONS, TOP_MARGIN_OPTIONS,
} from '../playback-options';

@Component({
  selector: 'app-subtitle-settings',
  imports: [TvSelectDirective, FormsModule, TranslatePipe, LucideTrash2, SubtitleAppearanceComponent, ToggleFieldComponent],
  templateUrl: './subtitle-settings.html',
})
export class SubtitleSettingsPageComponent {
  private readonly ps = inject(PlayerSettingsService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly languageOptions = LANGUAGE_OPTIONS;
  readonly subtitleModeOptions = SUBTITLE_MODE_OPTIONS;
  readonly hearingImpairedOptions = SUBTITLE_HI_OPTIONS;
  readonly bottomMarginOptions = BOTTOM_MARGIN_OPTIONS;
  readonly topMarginOptions = TOP_MARGIN_OPTIONS;

  private readonly initial = this.ps.get();
  readonly preferredSubtitleLanguage = signal(this.initial.preferredSubtitleLanguage);
  readonly subtitleMode = signal(this.initial.subtitleMode);
  readonly subtitleHearingImpaired = signal(this.initial.subtitleHearingImpaired);
  readonly rememberSubtitleSelections = signal(this.initial.rememberSubtitleSelections);
  readonly hideImageSubtitles = signal(this.initial.hideImageSubtitles);
  readonly showSubtitleFormat = signal(this.initial.showSubtitleFormat);
  readonly subtitleSize = signal(this.initial.subtitleSize);
  readonly subtitleColor = signal(this.initial.subtitleColor);
  readonly subtitleShadow = signal(this.initial.subtitleShadow);
  readonly subtitleBackground = signal(this.initial.subtitleBackground);
  readonly subtitleBottomMargin = signal(this.initial.subtitleBottomMargin);
  readonly subtitleTopMargin = signal(this.initial.subtitleTopMargin);

  constructor() {
    persistOnChange(
      () => ({
        preferredSubtitleLanguage: this.preferredSubtitleLanguage(),
        subtitleMode: this.subtitleMode(),
        subtitleHearingImpaired: this.subtitleHearingImpaired(),
        rememberSubtitleSelections: this.rememberSubtitleSelections(),
        hideImageSubtitles: this.hideImageSubtitles(),
        showSubtitleFormat: this.showSubtitleFormat(),
        subtitleSize: this.subtitleSize(),
        subtitleColor: this.subtitleColor(),
        subtitleShadow: this.subtitleShadow(),
        subtitleBackground: this.subtitleBackground(),
        subtitleBottomMargin: this.subtitleBottomMargin(),
        subtitleTopMargin: this.subtitleTopMargin(),
      }),
      // Spread first: other pages own fields of this store.
      (values) => this.ps.save({ ...this.ps.get(), ...values }),
    );
  }

  async clearSubtitleSelections() {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('playback_settings.sub_clear_saved'),
      message: this.translate.instant('playback_settings.sub_clear_saved_confirm'),
      confirmLabel: this.translate.instant('common.clear'),
      variant: 'danger',
    });
    if (!confirmed) return;
    this.ps.clearRememberedSubtitleTracks();
    this.toast.success(this.translate.instant('common.selections_cleared'));
  }
}
