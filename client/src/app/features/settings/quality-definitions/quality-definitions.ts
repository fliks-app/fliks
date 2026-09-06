import {
  Component,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  QualityDefinitionsApiService,
  QualityDefinition,
} from '../../../core/services/api/quality-definitions-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';

const MAX_SLIDER = 60000; // MB/h max for slider

@Component({
  selector: 'app-quality-definitions',
  imports: [FormsModule, TranslatePipe],
  templateUrl: './quality-definitions.html',
})
export class QualityDefinitionsComponent implements OnInit {
  private readonly api = inject(QualityDefinitionsApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);

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
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB/h`;
    return `${Math.round(mb)} MB/h`;
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
      this.toast.success(this.translate.instant('settings.quality_definitions.saved'));
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  onTrackMouseDown(event: MouseEvent, def: QualityDefinition, track: HTMLElement) {
    event.preventDefault();
    const field = this.closestField(event, def, track);
    const onMove = (e: MouseEvent) => this.dragTo(e.clientX, def, field, track);
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    this.dragTo(event.clientX, def, field, track);
  }

  onTrackTouchStart(event: TouchEvent, def: QualityDefinition, track: HTMLElement) {
    const field = this.closestField(event.touches[0], def, track);
    const onMove = (e: TouchEvent) => { e.preventDefault(); this.dragTo(e.touches[0].clientX, def, field, track); };
    const onEnd = () => { document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onEnd); };
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    this.dragTo(event.touches[0].clientX, def, field, track);
  }

  private closestField(point: { clientX: number }, def: QualityDefinition, track: HTMLElement): 'minSize' | 'preferredSize' | 'maxSize' {
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (point.clientX - rect.left) / rect.width));
    const value = pct * MAX_SLIDER;
    const distances = [
      { field: 'minSize' as const, dist: Math.abs(value - def.minSize) },
      { field: 'preferredSize' as const, dist: Math.abs(value - def.preferredSize) },
      { field: 'maxSize' as const, dist: Math.abs(value - (def.maxSize || MAX_SLIDER)) },
    ];
    return distances.sort((a, b) => a.dist - b.dist)[0].field;
  }

  private dragTo(clientX: number, def: QualityDefinition, field: 'minSize' | 'preferredSize' | 'maxSize', track: HTMLElement) {
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const value = Math.round(pct * MAX_SLIDER * 2) / 2; // snap to 0.5
    this.updateField(def, field, value);
  }

  async resetDefaults() {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('settings.quality_definitions.confirm_reset'), variant: 'warning' })) return;
    try {
      const defaults = await this.api.getDefaults();
      this.definitions.set(defaults);
      this.dirty.set(true);
    } catch {
      this.error.set(this.translate.instant('settings.quality_definitions.load_error'));
    }
  }
}
