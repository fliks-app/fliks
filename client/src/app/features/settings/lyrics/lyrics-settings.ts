import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';

const KEYS = {
  order: 'lyrics.provider_order',
  sidecars: 'lyrics.sidecars',
  writeBack: 'lyrics.write_back',
  autoFetch: 'lyrics.auto_fetch',
};

/** A stored JSON array of strings as editable text, one entry per `sep`. */
export function listText(raw: string | null | undefined, sep: string): string {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string').join(sep) : '';
  } catch {
    return '';
  }
}

export function listJson(text: string, split: RegExp): string {
  return JSON.stringify(
    text
      .split(split)
      .map((s) => s.trim().replace(/^\./, ''))
      .filter(Boolean),
  );
}

@Component({
  selector: 'app-lyrics-settings',
  imports: [FormsModule, TranslatePipe, ToggleFieldComponent],
  templateUrl: './lyrics-settings.html',
})
export class LyricsSettingsComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly loading = signal(true);
  readonly saving = signal(false);

  readonly autoFetch = signal(true);
  readonly writeBack = signal(false);
  readonly order = signal('');
  readonly sidecars = signal('');

  async ngOnInit() {
    try {
      const map = await this.api.getAll();
      this.autoFetch.set(map[KEYS.autoFetch] !== 'false');
      this.writeBack.set(map[KEYS.writeBack] === 'true');
      this.order.set(listText(map[KEYS.order], '\n'));
      this.sidecars.set(listText(map[KEYS.sidecars], ', '));
    } catch {
      this.toast.error(this.translate.instant('settings.lyrics.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  async save() {
    this.saving.set(true);
    try {
      await this.api.setBulk({
        [KEYS.autoFetch]: String(this.autoFetch()),
        [KEYS.writeBack]: String(this.writeBack()),
        [KEYS.order]: listJson(this.order(), /\n/),
        [KEYS.sidecars]: listJson(this.sidecars(), /[,\s]+/),
      });
      this.toast.success(this.translate.instant('settings.lyrics.saved'));
    } catch {
      // handled by global interceptor
    } finally {
      this.saving.set(false);
    }
  }
}
