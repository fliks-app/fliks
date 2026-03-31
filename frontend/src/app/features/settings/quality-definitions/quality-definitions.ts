import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  QualityDefinitionsApiService,
  QualityDefinition,
} from '../../../core/services/api/quality-definitions-api.service';

const MAX_SLIDER = 400; // MB/h max for slider

@Component({
  selector: 'app-quality-definitions',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './quality-definitions.html',
})
export class QualityDefinitionsComponent implements OnInit {
  private readonly api = inject(QualityDefinitionsApiService);
  private readonly translate = inject(TranslateService);

  readonly definitions = signal<QualityDefinition[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly dirty = signal(false);
  readonly error = signal('');

  readonly maxSlider = MAX_SLIDER;

  ngOnInit() {
    this.load();
  }

  async load() {
    this.loading.set(true);
    this.error.set('');
    try {
      this.definitions.set(await this.api.getAll());
      this.dirty.set(false);
    } catch {
      this.error.set(this.translate.instant('settings.quality_definitions.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  updateField(def: QualityDefinition, field: 'minSize' | 'preferredSize' | 'maxSize', value: number) {
    const defs = this.definitions().map((d) =>
      d.qualityId === def.qualityId ? { ...d, [field]: value } : d,
    );
    // Enforce min <= preferred <= max
    const updated = defs.find((d) => d.qualityId === def.qualityId)!;
    if (field === 'minSize' && value > updated.preferredSize) {
      updated.preferredSize = value;
    }
    if (field === 'minSize' && value > updated.maxSize && updated.maxSize > 0) {
      updated.maxSize = value;
    }
    if (field === 'preferredSize') {
      if (value < updated.minSize) updated.minSize = value;
      if (value > updated.maxSize && updated.maxSize > 0) updated.maxSize = value;
    }
    if (field === 'maxSize' && value > 0) {
      if (value < updated.preferredSize) updated.preferredSize = value;
      if (value < updated.minSize) updated.minSize = value;
    }
    this.definitions.set(defs);
    this.dirty.set(true);
  }

  updateTitle(def: QualityDefinition, title: string) {
    this.definitions.update((defs) =>
      defs.map((d) => (d.qualityId === def.qualityId ? { ...d, title } : d)),
    );
    this.dirty.set(true);
  }

  formatSize(mb: number): string {
    if (mb <= 0) return '0';
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GiB/h`;
    return `${mb.toFixed(1)} MiB/h`;
  }

  sliderPercent(value: number): number {
    return Math.min((value / MAX_SLIDER) * 100, 100);
  }

  async save() {
    this.saving.set(true);
    this.error.set('');
    try {
      const items = this.definitions().map((d) => ({
        qualityId: d.qualityId,
        title: d.title,
        minSize: d.minSize,
        preferredSize: d.preferredSize,
        maxSize: d.maxSize,
      }));
      this.definitions.set(await this.api.updateAll(items));
      this.dirty.set(false);
    } catch {
      this.error.set(this.translate.instant('settings.quality_definitions.save_error'));
    } finally {
      this.saving.set(false);
    }
  }

  resetDefaults() {
    if (!confirm(this.translate.instant('settings.quality_definitions.confirm_reset'))) return;
    // Reset to sensible defaults by resolution
    const defaults: Record<number, { min: number; preferred: number; max: number }> = {
      0: { min: 0, preferred: 95, max: 100 },
      480: { min: 0, preferred: 95, max: 100 },
      720: { min: 0, preferred: 137.3, max: 162.2 },
      1080: { min: 0, preferred: 137.3, max: 227.9 },
      2160: { min: 0, preferred: 302.5, max: 400 },
    };
    this.definitions.update((defs) =>
      defs.map((d) => {
        // Infer resolution from quality name
        let res = 0;
        if (d.title.includes('2160')) res = 2160;
        else if (d.title.includes('1080')) res = 1080;
        else if (d.title.includes('720')) res = 720;
        else if (d.title.includes('480') || d.title.includes('DVD') || d.title.includes('SDTV')) res = 480;
        const def = defaults[res] ?? defaults[0];
        return { ...d, ...def };
      }),
    );
    this.dirty.set(true);
  }
}
