import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { DisplaySettingsService } from '../../../core/services/display-settings.service';
import { SUPPORTED_LOCALES, resolveInitialLocale } from '../../../core/constants/app-locale';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';

@Component({
  selector: 'app-display-settings',
  imports: [TvSelectDirective, FormsModule, TranslateModule, ToggleFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './display-settings.html',
})
export class DisplaySettingsPageComponent implements OnInit {
  private readonly displaySettings = inject(DisplaySettingsService);
  private readonly translate = inject(TranslateService);

  readonly homeBackground = signal(true);
  readonly grayUnreleased = signal(true);
  readonly languageOptions = SUPPORTED_LOCALES;
  /** '' = follow the browser/OS language. */
  readonly language = signal('');

  ngOnInit() {
    const s = this.displaySettings.get();
    this.homeBackground.set(s.homeBackground);
    this.grayUnreleased.set(s.grayUnreleased);
    this.language.set(s.language);
  }

  onHomeBackgroundChange(value: boolean) {
    this.homeBackground.set(value);
    this.displaySettings.save({ homeBackground: value });
  }

  onGrayUnreleasedChange(value: boolean) {
    this.grayUnreleased.set(value);
    this.displaySettings.save({ grayUnreleased: value });
  }

  onLanguageChange(value: string) {
    if (value === this.language()) return;
    this.language.set(value);
    this.displaySettings.save({ language: value });
    // Switch the UI text live (no reload). '' resolves back to the browser/OS
    // language. Angular date/number formatting (LOCALE_ID) is fixed at bootstrap
    // so it follows on the next app launch.
    this.translate.use(resolveInitialLocale());
  }
}
