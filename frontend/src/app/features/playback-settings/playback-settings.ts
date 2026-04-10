import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { CastSettingsService, CastSettings } from '../../core/services/cast-settings.service';
import { PlayerSettingsService, PlayerSettings } from '../../core/services/player-settings.service';
import { ToastService } from '../../core/services/toast.service';
import { LucideCast, LucidePlay, LucideCaptions, LucideTrash2 } from '@lucide/angular';

@Component({
  selector: 'app-playback-settings',
  imports: [FormsModule, TranslateModule, LucideCast, LucidePlay, LucideCaptions, LucideTrash2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './playback-settings.html',
})
export class PlaybackSettingsComponent implements OnInit {
  private readonly castSettings = inject(CastSettingsService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly toast = inject(ToastService);

  readonly activeTab = signal<'player' | 'subtitles' | 'cast'>('player');

  // Cast settings
  readonly hdr = signal(false);
  readonly maxQuality = signal('1080p');
  readonly audioChannels = signal(2);

  // Player settings
  readonly preferredAudioLanguage = signal('');
  readonly useDefaultAudioStream = signal(false);
  readonly rememberAudioSelections = signal(false);

  // Subtitle settings
  readonly preferredSubtitleLanguage = signal('');
  readonly subtitleMode = signal<'off' | 'intelligent' | 'always'>('intelligent');
  readonly rememberSubtitleSelections = signal(false);
  readonly subtitleSize = signal('normal');
  readonly subtitleColor = signal('white');
  readonly subtitleShadow = signal('drop');
  readonly subtitleBackground = signal('transparent');
  readonly subtitleBottomMargin = signal(10);
  readonly subtitleTopMargin = signal(5);

  readonly qualityOptions = [
    { value: 'original', label: 'Original' },
    { value: '2160p', label: '4K (2160p)' },
    { value: '1080p', label: '1080p' },
    { value: '720p', label: '720p' },
    { value: '480p', label: '480p' },
  ];

  readonly audioOptions = [
    { value: 2, label: 'Stéréo (2.0)' },
    { value: 6, label: 'Surround 5.1' },
    { value: 8, label: 'Surround 7.1' },
  ];

  readonly languageOptions = [
    { value: '', label: 'Aucune préférence' },
    { value: 'fra', label: 'Français' },
    { value: 'eng', label: 'English' },
    { value: 'jpn', label: '日本語 (Japanese)' },
    { value: 'deu', label: 'Deutsch (German)' },
    { value: 'spa', label: 'Español (Spanish)' },
    { value: 'ita', label: 'Italiano (Italian)' },
    { value: 'por', label: 'Português (Portuguese)' },
    { value: 'kor', label: '한국어 (Korean)' },
    { value: 'zho', label: '中文 (Chinese)' },
    { value: 'rus', label: 'Русский (Russian)' },
    { value: 'ara', label: 'العربية (Arabic)' },
  ];

  readonly subtitleModeOptions = [
    { value: 'off', labelKey: 'playback_settings.sub_mode_off' },
    { value: 'intelligent', labelKey: 'playback_settings.sub_mode_intelligent' },
    { value: 'always', labelKey: 'playback_settings.sub_mode_always' },
  ];

  readonly sizeOptions = [
    { value: 'small', label: 'Petit' },
    { value: 'normal', label: 'Normal' },
    { value: 'large', label: 'Grand' },
    { value: 'xlarge', label: 'Très grand' },
  ];

  readonly colorOptions = [
    { value: 'white', label: 'Blanc' },
    { value: 'yellow', label: 'Jaune' },
    { value: 'green', label: 'Vert' },
    { value: 'cyan', label: 'Cyan' },
  ];

  readonly shadowOptions = [
    { value: 'none', label: 'Aucune' },
    { value: 'drop', label: 'Ombre portée' },
    { value: 'outline', label: 'Contour' },
    { value: 'raised', label: 'Relief' },
  ];

  readonly bgOptions = [
    { value: 'transparent', label: 'Transparent' },
    { value: 'semi', label: 'Noir semi-transparent' },
    { value: 'black', label: 'Noir' },
  ];

  readonly bottomMarginOptions = [0, 5, 10, 15, 20];
  readonly topMarginOptions = [0, 5, 10, 15];

  ngOnInit() {
    const c = this.castSettings.get();
    this.hdr.set(c.hdr);
    this.maxQuality.set(c.maxQuality);
    this.audioChannels.set(c.audioChannels);

    const p = this.playerSettings.get();
    this.preferredAudioLanguage.set(p.preferredAudioLanguage);
    this.useDefaultAudioStream.set(p.useDefaultAudioStream);
    this.rememberAudioSelections.set(p.rememberAudioSelections);
    this.preferredSubtitleLanguage.set(p.preferredSubtitleLanguage);
    this.subtitleMode.set(p.subtitleMode);
    this.rememberSubtitleSelections.set(p.rememberSubtitleSelections);
    this.subtitleSize.set(p.subtitleSize);
    this.subtitleColor.set(p.subtitleColor);
    this.subtitleShadow.set(p.subtitleShadow);
    this.subtitleBackground.set(p.subtitleBackground);
    this.subtitleBottomMargin.set(p.subtitleBottomMargin);
    this.subtitleTopMargin.set(p.subtitleTopMargin);
  }

  saveCast() {
    const settings: CastSettings = {
      hdr: this.hdr(),
      maxQuality: this.maxQuality(),
      audioChannels: this.audioChannels(),
    };
    this.castSettings.save(settings);
    this.toast.success('Paramètres enregistrés');
  }

  savePlayer() {
    this.saveAllPlayerSettings();
    this.toast.success('Paramètres enregistrés');
  }

  saveSubtitles() {
    this.saveAllPlayerSettings();
    this.toast.success('Paramètres enregistrés');
  }

  clearSubtitleSelections() {
    this.playerSettings.clearRememberedSubtitleTracks();
    this.toast.success('Sélections effacées');
  }

  private saveAllPlayerSettings() {
    const settings: PlayerSettings = {
      preferredAudioLanguage: this.preferredAudioLanguage(),
      useDefaultAudioStream: this.useDefaultAudioStream(),
      rememberAudioSelections: this.rememberAudioSelections(),
      preferredSubtitleLanguage: this.preferredSubtitleLanguage(),
      subtitleMode: this.subtitleMode(),
      rememberSubtitleSelections: this.rememberSubtitleSelections(),
      subtitleSize: this.subtitleSize(),
      subtitleColor: this.subtitleColor(),
      subtitleShadow: this.subtitleShadow(),
      subtitleBackground: this.subtitleBackground(),
      subtitleBottomMargin: this.subtitleBottomMargin(),
      subtitleTopMargin: this.subtitleTopMargin(),
    };
    this.playerSettings.save(settings);
  }
}
