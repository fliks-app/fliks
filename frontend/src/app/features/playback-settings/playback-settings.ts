import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { CastSettingsService, CastSettings } from '../../core/services/cast-settings.service';
import { ToastService } from '../../core/services/toast.service';
import { LucideCast } from '@lucide/angular';

@Component({
  selector: 'app-playback-settings',
  imports: [FormsModule, TranslateModule, LucideCast],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './playback-settings.html',
})
export class PlaybackSettingsComponent implements OnInit {
  private readonly castSettings = inject(CastSettingsService);
  private readonly toast = inject(ToastService);

  readonly hdr = signal(false);
  readonly maxQuality = signal('1080p');
  readonly audioChannels = signal(2);

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

  ngOnInit() {
    const s = this.castSettings.get();
    this.hdr.set(s.hdr);
    this.maxQuality.set(s.maxQuality);
    this.audioChannels.set(s.audioChannels);
  }

  save() {
    const settings: CastSettings = {
      hdr: this.hdr(),
      maxQuality: this.maxQuality(),
      audioChannels: this.audioChannels(),
    };
    this.castSettings.save(settings);
    this.toast.success('Paramètres enregistrés');
  }
}
