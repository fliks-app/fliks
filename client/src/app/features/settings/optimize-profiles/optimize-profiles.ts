import { Component, ElementRef, OnInit, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { OptimizeService } from '../../../core/services/api/optimize.service';
import { formatChoice, type OptimizeProfile, type PresetKey } from '../../../core/models/optimize';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';

const PRESETS: PresetKey[] = ['balanced', 'cleanup_only', 'direct_playback'];

@Component({
  selector: 'app-optimize-profiles',
  imports: [RouterLink, TranslatePipe, ModalHeaderComponent],
  templateUrl: './optimize-profiles.html',
})
export class OptimizeProfilesComponent implements OnInit {
  private readonly api = inject(OptimizeService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  private readonly presetDialog = viewChild<ElementRef<HTMLDialogElement>>('presetDialog');

  readonly presets = PRESETS;
  readonly profiles = signal<OptimizeProfile[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal(false);

  ngOnInit() {
    void this.load();
  }

  async load() {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      this.profiles.set(await this.api.profiles());
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  format(p: OptimizeProfile) {
    return formatChoice(p.document.video);
  }

  openPresets() {
    this.presetDialog()?.nativeElement.showModal();
  }

  closePresets() {
    this.presetDialog()?.nativeElement.close();
  }

  create(preset: PresetKey) {
    this.closePresets();
    void this.router.navigate(['/admin/settings/optimize-profiles/new'], {
      queryParams: { preset },
    });
  }

  async remove(p: OptimizeProfile) {
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('settings.optimize.profiles.confirm_delete', {
        name: p.name,
        count: p.libraryCount,
      }),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await this.api.deleteProfile(p.id);
      await this.load();
    } catch {
      // The global interceptor toasts the reason.
    }
  }
}
