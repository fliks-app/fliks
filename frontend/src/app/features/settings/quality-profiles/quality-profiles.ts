import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  signal,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  ProfilesService,
  QualityProfile,
} from '../../../core/services/api/profiles.service';
import {
  MediaService,
  SuitarrQualityDef,
} from '../../../core/services/api/media.service';

@Component({
  selector: 'app-quality-profiles',
  imports: [FormsModule, RouterLink, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './quality-profiles.html',
})
export class QualityProfilesComponent implements OnInit {
  private readonly profilesApi = inject(ProfilesService);
  private readonly mediaApi = inject(MediaService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly profiles = signal<QualityProfile[]>([]);
  readonly definitions = signal<SuitarrQualityDef[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly saving = signal(false);

  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly formCutoff = signal(16);
  readonly formUpgrade = signal(true);
  readonly allowedIds = signal<Set<number>>(new Set());

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    this.listError.set('');
    try {
      const [profiles, defs] = await Promise.all([
        this.profilesApi.getQualityProfiles(),
        this.mediaApi.getSuitarrQualities(),
      ]);
      this.profiles.set(profiles);
      this.definitions.set(defs);
    } catch {
      this.listError.set(
        this.translate.instant('settings.quality_profiles.load_error'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  cutoffLabel(id: number): string {
    const d = this.definitions().find((q) => q.id === id);
    return d ? d.name : String(id);
  }

  allowedCount(p: QualityProfile): number {
    return p.items.filter((i) => i.allowed).length;
  }

  openCreate() {
    this.editingId.set(null);
    this.formName.set('');
    this.formCutoff.set(16);
    this.formUpgrade.set(true);
    this.allowedIds.set(new Set());
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(p: QualityProfile) {
    this.editingId.set(p.id);
    this.formName.set(p.name);
    this.formCutoff.set(p.cutoff);
    this.formUpgrade.set(p.upgradeAllowed);
    const allowed = new Set(
      p.items.filter((i) => i.allowed).map((i) => i.quality.id),
    );
    this.allowedIds.set(allowed);
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  isAllowed(id: number): boolean {
    return this.allowedIds().has(id);
  }

  toggleQuality(id: number, ev: Event) {
    const checked = (ev.target as HTMLInputElement).checked;
    const next = new Set(this.allowedIds());
    if (checked) next.add(id);
    else next.delete(id);
    this.allowedIds.set(next);
  }

  private buildPayload() {
    const defs = this.definitions();
    return {
      name: this.formName().trim(),
      cutoff: this.formCutoff(),
      upgradeAllowed: this.formUpgrade(),
      items: defs.map((q, index) => ({
        qualityId: q.id,
        qualityName: q.name,
        resolution: q.resolution,
        source: q.source,
        allowed: this.allowedIds().has(q.id),
        sortOrder: index,
      })),
    };
  }

  async save() {
    const name = this.formName().trim();
    if (!name) return;
    this.saving.set(true);
    const body = this.buildPayload();
    const id = this.editingId();
    try {
      await (id == null
        ? this.profilesApi.createQualityProfile(body)
        : this.profilesApi.updateQualityProfile(id, body));
      this.closeEditor();
      await this.reloadAll();
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  async deleteProfile(p: QualityProfile) {
    const msg = this.translate.instant(
      'settings.quality_profiles.confirm_delete',
      { name: p.name },
    );
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: msg, variant: 'danger' })) return;
    try {
      await this.profilesApi.deleteQualityProfile(p.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({
        title: this.translate.instant('common.error'),
        message: httpErr.error?.message ??
          this.translate.instant('settings.quality_profiles.delete_error'),
        variant: 'danger',
      });
    }
  }
}
