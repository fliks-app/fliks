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
  ProfilesService,
  LanguageProfile,
} from '../../../core/services/api/profiles.service';

interface LangDef {
  id: number;
  name: string;
  isoCode: string;
}

@Component({
  selector: 'app-language-profiles',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './language-profiles.html',
})
export class LanguageProfilesComponent implements OnInit {
  private readonly api = inject(ProfilesService);
  private readonly translate = inject(TranslateService);

  readonly profiles = signal<LanguageProfile[]>([]);
  readonly definitions = signal<LangDef[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly editorOpen = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly formCutoff = signal(1);
  readonly allowedIds = signal<Set<number>>(new Set());

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    this.listError.set('');
    try {
      const [profiles, defs] = await Promise.all([
        this.api.getLanguageProfiles(),
        this.api.getLanguageDefinitions(),
      ]);
      this.profiles.set(profiles);
      this.definitions.set(defs);
    } catch {
      this.listError.set(this.translate.instant('settings.language_profiles.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  cutoffLabel(id: number): string {
    const d = this.definitions().find((l) => l.id === id);
    return d ? d.name : String(id);
  }

  allowedCount(p: LanguageProfile): number {
    return p.languages.filter((l) => l.allowed).length;
  }

  openCreate() {
    this.editingId.set(null);
    this.formName.set('');
    this.formCutoff.set(1);
    this.allowedIds.set(new Set());
    this.saveError.set('');
    this.editorOpen.set(true);
  }

  openEdit(p: LanguageProfile) {
    this.editingId.set(p.id);
    this.formName.set(p.name);
    this.formCutoff.set(p.cutoff);
    this.allowedIds.set(new Set(p.languages.filter((l) => l.allowed).map((l) => l.language.id)));
    this.saveError.set('');
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
  }

  isAllowed(id: number): boolean {
    return this.allowedIds().has(id);
  }

  toggleLanguage(id: number, ev: Event) {
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
      languages: defs.map((l, index) => ({
        languageId: l.id,
        languageName: l.name,
        isoCode: l.isoCode,
        allowed: this.allowedIds().has(l.id),
        sortOrder: index,
      })),
    };
  }

  async save() {
    const name = this.formName().trim();
    if (!name) {
      this.saveError.set(this.translate.instant('settings.language_profiles.name_required'));
      return;
    }
    this.saving.set(true);
    this.saveError.set('');
    const body = this.buildPayload();
    const id = this.editingId();
    try {
      await (id == null
        ? this.api.createLanguageProfile(body)
        : this.api.updateLanguageProfile(id, body));
      this.closeEditor();
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.saveError.set(
        httpErr.error?.message ?? this.translate.instant('settings.language_profiles.save_error'),
      );
    } finally {
      this.saving.set(false);
    }
  }

  async deleteProfile(p: LanguageProfile) {
    const msg = this.translate.instant('settings.language_profiles.confirm_delete', { name: p.name });
    if (!confirm(msg)) return;
    try {
      await this.api.deleteLanguageProfile(p.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      alert(httpErr.error?.message ?? this.translate.instant('settings.language_profiles.delete_error'));
    }
  }
}
