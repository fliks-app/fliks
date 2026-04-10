import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { CastSettingsService, CastSettings } from '../../core/services/cast-settings.service';
import { ToastService } from '../../core/services/toast.service';
import { QUALITY_OPTIONS, AUDIO_CHANNEL_OPTIONS } from './playback-options';

@Component({
  selector: 'app-cast-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-2xl font-bold mb-4">Chromecast</h1>
    <div class="card bg-base-100 border border-base-200">
      <div class="card-body gap-5">
        <div class="form-control">
          <label class="label cursor-pointer justify-start gap-4">
            <input type="checkbox" class="toggle toggle-primary" [ngModel]="hdr()" (ngModelChange)="hdr.set($event)" />
            <div>
              <span class="label-text font-medium">{{ 'playback_settings.cast_hdr' | translate }}</span>
              <p class="text-xs text-base-content/50 mt-0.5">{{ 'playback_settings.cast_hdr_hint' | translate }}</p>
            </div>
          </label>
        </div>

        <div class="divider my-0"></div>

        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.cast_max_quality' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="maxQuality()" (ngModelChange)="maxQuality.set($event)">
            @for (q of qualityOptions; track q.value) { <option [value]="q.value">{{ q.label }}</option> }
          </select>
          <div class="label"><span class="label-text-alt text-base-content/50">{{ 'playback_settings.cast_max_quality_hint' | translate }}</span></div>
        </label>

        <div class="divider my-0"></div>

        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.cast_audio' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="audioChannels()" (ngModelChange)="audioChannels.set(+$event)">
            @for (a of audioOptions; track a.value) { <option [ngValue]="a.value">{{ a.label }}</option> }
          </select>
          <div class="label"><span class="label-text-alt text-base-content/50">{{ 'playback_settings.cast_audio_hint' | translate }}</span></div>
        </label>

        <div class="card-actions justify-end pt-2">
          <button class="btn btn-primary" (click)="save()">{{ 'common.save' | translate }}</button>
        </div>
      </div>
    </div>
  `,
})
export class CastSettingsPageComponent implements OnInit {
  private readonly castSettings = inject(CastSettingsService);
  private readonly toast = inject(ToastService);

  readonly qualityOptions = QUALITY_OPTIONS;
  readonly audioOptions = AUDIO_CHANNEL_OPTIONS;

  readonly hdr = signal(false);
  readonly maxQuality = signal('1080p');
  readonly audioChannels = signal(2);

  ngOnInit() {
    const c = this.castSettings.get();
    this.hdr.set(c.hdr);
    this.maxQuality.set(c.maxQuality);
    this.audioChannels.set(c.audioChannels);
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
