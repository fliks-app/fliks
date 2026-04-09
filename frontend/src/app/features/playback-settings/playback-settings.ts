import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { CastSettingsService, CastSettings } from '../../core/services/cast-settings.service';
import { PlayerSettingsService, PlayerSettings } from '../../core/services/player-settings.service';
import { ToastService } from '../../core/services/toast.service';
import { LucideCast, LucidePlay } from '@lucide/angular';

@Component({
  selector: 'app-playback-settings',
  imports: [FormsModule, TranslateModule, LucideCast, LucidePlay],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './playback-settings.html',
})
export class PlaybackSettingsComponent implements OnInit {
  private readonly castSettings = inject(CastSettingsService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly toast = inject(ToastService);

  readonly activeTab = signal<'player' | 'cast'>('player');

  // Cast settings
  readonly hdr = signal(false);
  readonly maxQuality = signal('1080p');
  readonly audioChannels = signal(2);

  // Player settings
  readonly preferredAudioLanguage = signal('');
  readonly useDefaultAudioStream = signal(false);
  readonly rememberAudioSelections = signal(false);

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

  ngOnInit() {
    const c = this.castSettings.get();
    this.hdr.set(c.hdr);
    this.maxQuality.set(c.maxQuality);
    this.audioChannels.set(c.audioChannels);

    const p = this.playerSettings.get();
    this.preferredAudioLanguage.set(p.preferredAudioLanguage);
    this.useDefaultAudioStream.set(p.useDefaultAudioStream);
    this.rememberAudioSelections.set(p.rememberAudioSelections);
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
    const settings: PlayerSettings = {
      preferredAudioLanguage: this.preferredAudioLanguage(),
      useDefaultAudioStream: this.useDefaultAudioStream(),
      rememberAudioSelections: this.rememberAudioSelections(),
    };
    this.playerSettings.save(settings);
    this.toast.success('Paramètres enregistrés');
  }
}
