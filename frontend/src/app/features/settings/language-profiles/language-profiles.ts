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
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  ProfilesService,
  LanguageProfile,
  AudioLanguageItem,
  SubtitleLanguageItem,
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
  private readonly confirmation = inject(ConfirmationService);

  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly profiles = signal<LanguageProfile[]>([]);
  readonly definitions = signal<LangDef[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly audioIsoCodes = signal<Set<string>>(new Set());
  readonly subtitleEntries = signal<Map<string, { forced: boolean; hi: boolean }>>(new Map());

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

  audioCount(p: LanguageProfile): number {
    return p.audioLanguages.length;
  }

  subtitleCount(p: LanguageProfile): number {
    return p.subtitleLanguages.length;
  }

  openCreate() {
    this.editingId.set(null);
    this.formName.set('');
    this.audioIsoCodes.set(new Set());
    this.subtitleEntries.set(new Map());
    this.saveError.set('');
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(p: LanguageProfile) {
    this.editingId.set(p.id);
    this.formName.set(p.name);
    this.audioIsoCodes.set(new Set(p.audioLanguages.map((l) => l.isoCode)));
    const subs = new Map<string, { forced: boolean; hi: boolean }>();
    for (const s of p.subtitleLanguages) {
      subs.set(s.isoCode, { forced: s.forced, hi: s.hi });
    }
    this.subtitleEntries.set(subs);
    this.saveError.set('');
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  isAudioSelected(isoCode: string): boolean {
    return this.audioIsoCodes().has(isoCode);
  }

  toggleAudio(isoCode: string, ev: Event) {
    const checked = (ev.target as HTMLInputElement).checked;
    const next = new Set(this.audioIsoCodes());
    if (checked) next.add(isoCode);
    else next.delete(isoCode);
    this.audioIsoCodes.set(next);
  }

  isSubtitleSelected(isoCode: string): boolean {
    return this.subtitleEntries().has(isoCode);
  }

  toggleSubtitle(isoCode: string, ev: Event) {
    const checked = (ev.target as HTMLInputElement).checked;
    const next = new Map(this.subtitleEntries());
    if (checked) next.set(isoCode, { forced: false, hi: false });
    else next.delete(isoCode);
    this.subtitleEntries.set(next);
  }

  isSubForced(isoCode: string): boolean {
    return this.subtitleEntries().get(isoCode)?.forced ?? false;
  }

  isSubHi(isoCode: string): boolean {
    return this.subtitleEntries().get(isoCode)?.hi ?? false;
  }

  toggleSubForced(isoCode: string, ev: Event) {
    const checked = (ev.target as HTMLInputElement).checked;
    const next = new Map(this.subtitleEntries());
    const entry = next.get(isoCode);
    if (entry) {
      next.set(isoCode, { ...entry, forced: checked });
      this.subtitleEntries.set(next);
    }
  }

  toggleSubHi(isoCode: string, ev: Event) {
    const checked = (ev.target as HTMLInputElement).checked;
    const next = new Map(this.subtitleEntries());
    const entry = next.get(isoCode);
    if (entry) {
      next.set(isoCode, { ...entry, hi: checked });
      this.subtitleEntries.set(next);
    }
  }

  private buildPayload() {
    const defs = this.definitions();
    const audioLanguages: AudioLanguageItem[] = [];
    for (const iso of this.audioIsoCodes()) {
      const def = defs.find((d) => d.isoCode === iso);
      if (def) audioLanguages.push({ isoCode: def.isoCode, name: def.name });
    }
    const subtitleLanguages: SubtitleLanguageItem[] = [];
    for (const [iso, opts] of this.subtitleEntries()) {
      const def = defs.find((d) => d.isoCode === iso);
      if (def) subtitleLanguages.push({ isoCode: def.isoCode, name: def.name, forced: opts.forced, hi: opts.hi });
    }
    return { name: this.formName().trim(), audioLanguages, subtitleLanguages };
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
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: msg, variant: 'danger' })) return;
    try {
      await this.api.deleteLanguageProfile(p.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? this.translate.instant('settings.language_profiles.delete_error'), variant: 'danger' });
    }
  }
}
