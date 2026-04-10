import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { PlayerSettingsService } from '../../core/services/player-settings.service';
import { ToastService } from '../../core/services/toast.service';
import { LANGUAGE_OPTIONS } from './playback-options';

@Component({
  selector: 'app-player-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-2xl font-bold mb-4">{{ 'app_settings.nav.player' | translate }}</h1>
    <div class="card bg-base-100 border border-base-200">
      <div class="card-body gap-5">
        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.player_preferred_lang' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="preferredAudioLanguage()" (ngModelChange)="preferredAudioLanguage.set($event)">
            @for (l of languageOptions; track l.value) { <option [value]="l.value">{{ l.label }}</option> }
          </select>
          <div class="label"><span class="label-text-alt text-base-content/50">{{ 'playback_settings.player_preferred_lang_hint' | translate }}</span></div>
        </label>

        <div class="divider my-0"></div>

        <div class="form-control">
          <label class="label cursor-pointer justify-start gap-4">
            <input type="checkbox" class="toggle toggle-primary" [ngModel]="useDefaultAudioStream()" (ngModelChange)="useDefaultAudioStream.set($event)" />
            <div>
              <span class="label-text font-medium">{{ 'playback_settings.player_use_default' | translate }}</span>
              <p class="text-xs text-base-content/50 mt-0.5">{{ 'playback_settings.player_use_default_hint' | translate }}</p>
            </div>
          </label>
        </div>

        <div class="divider my-0"></div>

        <div class="form-control">
          <label class="label cursor-pointer justify-start gap-4">
            <input type="checkbox" class="toggle toggle-primary" [ngModel]="rememberAudioSelections()" (ngModelChange)="rememberAudioSelections.set($event)" />
            <div>
              <span class="label-text font-medium">{{ 'playback_settings.player_remember_audio' | translate }}</span>
              <p class="text-xs text-base-content/50 mt-0.5">{{ 'playback_settings.player_remember_audio_hint' | translate }}</p>
            </div>
          </label>
        </div>

        <div class="card-actions justify-end pt-2">
          <button class="btn btn-primary" (click)="save()">{{ 'common.save' | translate }}</button>
        </div>
      </div>
    </div>
  `,
})
export class PlayerSettingsPageComponent implements OnInit {
  private readonly ps = inject(PlayerSettingsService);
  private readonly toast = inject(ToastService);

  readonly languageOptions = LANGUAGE_OPTIONS;
  readonly preferredAudioLanguage = signal('');
  readonly useDefaultAudioStream = signal(false);
  readonly rememberAudioSelections = signal(false);

  ngOnInit() {
    const p = this.ps.get();
    this.preferredAudioLanguage.set(p.preferredAudioLanguage);
    this.useDefaultAudioStream.set(p.useDefaultAudioStream);
    this.rememberAudioSelections.set(p.rememberAudioSelections);
  }

  save() {
    const current = this.ps.get();
    this.ps.save({
      ...current,
      preferredAudioLanguage: this.preferredAudioLanguage(),
      useDefaultAudioStream: this.useDefaultAudioStream(),
      rememberAudioSelections: this.rememberAudioSelections(),
    });
    this.toast.success('Paramètres enregistrés');
  }
}
