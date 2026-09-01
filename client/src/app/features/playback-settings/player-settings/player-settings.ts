import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideTrash2 } from '@lucide/angular';
import { PlayerSettingsService } from '../../../core/services/player-settings.service';
import { BrowserDeviceProfileService } from '../../../core/services/browser-device-profile.service';
import { ToastService } from '../../../core/services/toast.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';
import { LANGUAGE_OPTIONS } from '../playback-options';

@Component({
  selector: 'app-player-settings',
  imports: [
    FormsModule,
    TranslateModule,
    LucideTrash2,
    ToggleFieldComponent,
    SelectFieldComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player-settings.html',
})
export class PlayerSettingsPageComponent implements OnInit {
  private readonly ps = inject(PlayerSettingsService);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly languageOptions = LANGUAGE_OPTIONS;
  readonly preferredAudioLanguage = signal('');
  readonly useDefaultAudioStream = signal(false);
  readonly rememberAudioSelections = signal(false);
  readonly forceDisableHdr = signal(false);
  readonly showHdrToggle = signal(false);
  readonly showEcoQualities = signal(true);
  readonly autoSkipIntro = signal(false);
  readonly autoPlayNext = signal(true);

  ngOnInit() {
    const p = this.ps.get();
    this.preferredAudioLanguage.set(p.preferredAudioLanguage);
    this.useDefaultAudioStream.set(p.useDefaultAudioStream);
    this.rememberAudioSelections.set(p.rememberAudioSelections);
    this.forceDisableHdr.set(p.forceDisableHdr);
    this.showHdrToggle.set(this.deviceProfile.hardwareSupportsHdr);
    this.showEcoQualities.set(p.showEcoQualities);
    this.autoSkipIntro.set(p.autoSkipIntro);
    this.autoPlayNext.set(p.autoPlayNext);
  }

  clearAudioSelections() {
    this.ps.clearRememberedAudioTracks();
    this.toast.success(this.translate.instant('common.selections_cleared'));
  }

  save() {
    const current = this.ps.get();
    this.ps.save({
      ...current,
      preferredAudioLanguage: this.preferredAudioLanguage(),
      useDefaultAudioStream: this.useDefaultAudioStream(),
      rememberAudioSelections: this.rememberAudioSelections(),
      forceDisableHdr: this.forceDisableHdr(),
      showEcoQualities: this.showEcoQualities(),
      autoSkipIntro: this.autoSkipIntro(),
      autoPlayNext: this.autoPlayNext(),
    });
    this.toast.success(this.translate.instant('common.settings_saved'));
  }
}
