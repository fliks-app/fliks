import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { PlayerSettingsService } from '../../../core/services/player-settings.service';
import { ToastService } from '../../../core/services/toast.service';
import { LucideTrash2 } from '@lucide/angular';
import { SubtitleAppearanceComponent } from '../../../shared/components/subtitle-appearance/subtitle-appearance';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import {
  LANGUAGE_OPTIONS, SUBTITLE_MODE_OPTIONS,
  BOTTOM_MARGIN_OPTIONS, TOP_MARGIN_OPTIONS,
} from '../playback-options';

@Component({
  selector: 'app-subtitle-settings',
  imports: [FormsModule, TranslateModule, LucideTrash2, SubtitleAppearanceComponent, ToggleFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './subtitle-settings.html',
})
export class SubtitleSettingsPageComponent implements OnInit {
  private readonly ps = inject(PlayerSettingsService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly languageOptions = LANGUAGE_OPTIONS;
  readonly subtitleModeOptions = SUBTITLE_MODE_OPTIONS;
  readonly bottomMarginOptions = BOTTOM_MARGIN_OPTIONS;
  readonly topMarginOptions = TOP_MARGIN_OPTIONS;

  readonly preferredSubtitleLanguage = signal('');
  readonly subtitleMode = signal<'off' | 'intelligent' | 'always'>('intelligent');
  readonly rememberSubtitleSelections = signal(false);
  readonly hideImageSubtitles = signal(true);
  readonly subtitleSize = signal('normal');
  readonly subtitleColor = signal('white');
  readonly subtitleShadow = signal('drop');
  readonly subtitleBackground = signal('transparent');
  readonly subtitleBottomMargin = signal(10);
  readonly subtitleTopMargin = signal(5);

  ngOnInit() {
    const p = this.ps.get();
    this.preferredSubtitleLanguage.set(p.preferredSubtitleLanguage);
    this.subtitleMode.set(p.subtitleMode);
    this.rememberSubtitleSelections.set(p.rememberSubtitleSelections);
    this.hideImageSubtitles.set(p.hideImageSubtitles);
    this.subtitleSize.set(p.subtitleSize);
    this.subtitleColor.set(p.subtitleColor);
    this.subtitleShadow.set(p.subtitleShadow);
    this.subtitleBackground.set(p.subtitleBackground);
    this.subtitleBottomMargin.set(p.subtitleBottomMargin);
    this.subtitleTopMargin.set(p.subtitleTopMargin);
  }

  clearSubtitleSelections() {
    this.ps.clearRememberedSubtitleTracks();
    this.toast.success(this.translate.instant('common.selections_cleared'));
  }

  save() {
    const current = this.ps.get();
    this.ps.save({
      ...current,
      preferredSubtitleLanguage: this.preferredSubtitleLanguage(),
      subtitleMode: this.subtitleMode(),
      rememberSubtitleSelections: this.rememberSubtitleSelections(),
      hideImageSubtitles: this.hideImageSubtitles(),
      subtitleSize: this.subtitleSize(),
      subtitleColor: this.subtitleColor(),
      subtitleShadow: this.subtitleShadow(),
      subtitleBackground: this.subtitleBackground(),
      subtitleBottomMargin: this.subtitleBottomMargin(),
      subtitleTopMargin: this.subtitleTopMargin(),
    });
    this.toast.success(this.translate.instant('common.settings_saved'));
  }
}
