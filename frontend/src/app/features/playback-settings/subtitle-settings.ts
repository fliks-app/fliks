import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { PlayerSettingsService } from '../../core/services/player-settings.service';
import { ToastService } from '../../core/services/toast.service';
import { LucideTrash2 } from '@lucide/angular';
import {
  LANGUAGE_OPTIONS, SUBTITLE_MODE_OPTIONS,
  SIZE_OPTIONS, COLOR_OPTIONS, SHADOW_OPTIONS, BG_OPTIONS,
  BOTTOM_MARGIN_OPTIONS, TOP_MARGIN_OPTIONS,
} from './playback-options';

@Component({
  selector: 'app-subtitle-settings',
  imports: [FormsModule, TranslateModule, LucideTrash2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-2xl font-bold mb-4">{{ 'app_settings.nav.subtitles' | translate }}</h1>
    <div class="card bg-base-100 border border-base-200">
      <div class="card-body gap-5">
        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_preferred_lang' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="preferredSubtitleLanguage()" (ngModelChange)="preferredSubtitleLanguage.set($event)">
            @for (l of languageOptions; track l.value) { <option [value]="l.value">{{ l.label }}</option> }
          </select>
        </label>

        <div class="divider my-0"></div>

        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_mode' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="subtitleMode()" (ngModelChange)="subtitleMode.set($event)">
            @for (m of subtitleModeOptions; track m.value) { <option [value]="m.value">{{ m.labelKey | translate }}</option> }
          </select>
          <div class="label"><span class="label-text-alt text-base-content/50">{{ 'playback_settings.sub_mode_hint' | translate }}</span></div>
        </label>

        <div class="divider my-0"></div>

        <div class="form-control">
          <label class="label cursor-pointer justify-start gap-4">
            <input type="checkbox" class="toggle toggle-primary" [ngModel]="rememberSubtitleSelections()" (ngModelChange)="rememberSubtitleSelections.set($event)" />
            <div>
              <span class="label-text font-medium">{{ 'playback_settings.sub_remember' | translate }}</span>
              <p class="text-xs text-base-content/50 mt-0.5">{{ 'playback_settings.sub_remember_hint' | translate }}</p>
            </div>
          </label>
        </div>

        <button class="btn btn-ghost btn-sm text-error gap-2 self-start" (click)="clearSubtitleSelections()">
          <svg lucideTrash2 class="h-4 w-4"></svg>
          {{ 'playback_settings.sub_clear_saved' | translate }}
        </button>

        <div class="divider my-0"></div>

        <h2 class="text-lg font-bold">{{ 'playback_settings.sub_appearance_title' | translate }}</h2>
        <p class="text-xs text-base-content/50 -mt-4">{{ 'playback_settings.sub_appearance_hint' | translate }}</p>

        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_size' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="subtitleSize()" (ngModelChange)="subtitleSize.set($event)">
            @for (s of sizeOptions; track s.value) { <option [value]="s.value">{{ s.label }}</option> }
          </select>
        </label>

        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_color' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="subtitleColor()" (ngModelChange)="subtitleColor.set($event)">
            @for (c of colorOptions; track c.value) { <option [value]="c.value">{{ c.label }}</option> }
          </select>
        </label>

        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_shadow' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="subtitleShadow()" (ngModelChange)="subtitleShadow.set($event)">
            @for (s of shadowOptions; track s.value) { <option [value]="s.value">{{ s.label }}</option> }
          </select>
        </label>

        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_bg' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="subtitleBackground()" (ngModelChange)="subtitleBackground.set($event)">
            @for (b of bgOptions; track b.value) { <option [value]="b.value">{{ b.label }}</option> }
          </select>
        </label>

        <div class="divider my-0"></div>

        <h2 class="text-lg font-bold">{{ 'playback_settings.sub_position_title' | translate }}</h2>

        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_bottom_margin' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="subtitleBottomMargin()" (ngModelChange)="subtitleBottomMargin.set(+$event)">
            @for (v of bottomMarginOptions; track v) { <option [ngValue]="v">{{ v }}%</option> }
          </select>
          <div class="label"><span class="label-text-alt text-base-content/50">{{ 'playback_settings.sub_bottom_margin_hint' | translate }}</span></div>
        </label>

        <label class="form-control w-full max-w-xs">
          <div class="label"><span class="label-text font-medium">{{ 'playback_settings.sub_top_margin' | translate }}</span></div>
          <select class="select select-bordered w-full" [ngModel]="subtitleTopMargin()" (ngModelChange)="subtitleTopMargin.set(+$event)">
            @for (v of topMarginOptions; track v) { <option [ngValue]="v">{{ v }}%</option> }
          </select>
          <div class="label"><span class="label-text-alt text-base-content/50">{{ 'playback_settings.sub_top_margin_hint' | translate }}</span></div>
        </label>

        <div class="card-actions justify-end pt-2">
          <button class="btn btn-primary" (click)="save()">{{ 'common.save' | translate }}</button>
        </div>
      </div>
    </div>
  `,
})
export class SubtitleSettingsPageComponent implements OnInit {
  private readonly ps = inject(PlayerSettingsService);
  private readonly toast = inject(ToastService);

  readonly languageOptions = LANGUAGE_OPTIONS;
  readonly subtitleModeOptions = SUBTITLE_MODE_OPTIONS;
  readonly sizeOptions = SIZE_OPTIONS;
  readonly colorOptions = COLOR_OPTIONS;
  readonly shadowOptions = SHADOW_OPTIONS;
  readonly bgOptions = BG_OPTIONS;
  readonly bottomMarginOptions = BOTTOM_MARGIN_OPTIONS;
  readonly topMarginOptions = TOP_MARGIN_OPTIONS;

  readonly preferredSubtitleLanguage = signal('');
  readonly subtitleMode = signal<'off' | 'intelligent' | 'always'>('intelligent');
  readonly rememberSubtitleSelections = signal(false);
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
    this.subtitleSize.set(p.subtitleSize);
    this.subtitleColor.set(p.subtitleColor);
    this.subtitleShadow.set(p.subtitleShadow);
    this.subtitleBackground.set(p.subtitleBackground);
    this.subtitleBottomMargin.set(p.subtitleBottomMargin);
    this.subtitleTopMargin.set(p.subtitleTopMargin);
  }

  clearSubtitleSelections() {
    this.ps.clearRememberedSubtitleTracks();
    this.toast.success('Sélections effacées');
  }

  save() {
    const current = this.ps.get();
    this.ps.save({
      ...current,
      preferredSubtitleLanguage: this.preferredSubtitleLanguage(),
      subtitleMode: this.subtitleMode(),
      rememberSubtitleSelections: this.rememberSubtitleSelections(),
      subtitleSize: this.subtitleSize(),
      subtitleColor: this.subtitleColor(),
      subtitleShadow: this.subtitleShadow(),
      subtitleBackground: this.subtitleBackground(),
      subtitleBottomMargin: this.subtitleBottomMargin(),
      subtitleTopMargin: this.subtitleTopMargin(),
    });
    this.toast.success('Paramètres enregistrés');
  }
}
