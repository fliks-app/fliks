import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  computed,
  signal,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  CustomFormatsApiService,
  CustomFormat,
  CustomFormatMatch,
  CustomFormatSpec,
  CustomFormatSpecType,
  CUSTOM_FORMAT_SPEC_TYPES,
} from '../../../core/services/api/custom-formats-api.service';
import { ProfilesService } from '../../../core/services/api/profiles.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';

/**
 * Condition values that come from a closed vocabulary — the backend matches them
 * against the parsed release attribute, so a free-typed variant simply never
 * matches. Types absent here take free text (a regex, a release group).
 */
const VALUE_OPTIONS: Partial<Record<CustomFormatSpecType, readonly string[]>> = {
  source: ['remux', 'bluray', 'web-dl', 'webrip', 'hdtv', 'dvd', 'sdtv', 'cam', 'ts', 'tc'],
  resolution: ['4320p', '2160p', '1080p', '720p', '576p', '480p', '360p'],
  release_flag: ['freeleech', 'halfleech'],
  edition: [
    'directors-cut',
    'extended',
    'theatrical',
    'uncut',
    'remastered',
    'criterion',
    'imax',
  ],
  video_codec: ['h265', 'h264', 'av1', 'vp9', 'xvid', 'mpeg2'],
  audio_codec: ['truehd', 'dts-hd', 'dts', 'eac3', 'ac3', 'flac', 'aac', 'opus', 'mp3'],
};

@Component({
  selector: 'app-custom-formats-settings',
  imports: [TvSelectDirective, ModalFooterComponent, ModalHeaderComponent, FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './custom-formats.html',
})
export class CustomFormatsSettingsComponent implements OnInit {
  private readonly api = inject(CustomFormatsApiService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly rows = signal<CustomFormat[]>([]);
  readonly languages = signal<{ isoCode: string; name: string }[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly saving = signal(false);

  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly formScore = signal(0);
  readonly formSpecs = signal<CustomFormatSpec[]>([]);

  readonly testTitle = signal('');
  readonly testFreeleech = signal(false);
  readonly testResults = signal<CustomFormatMatch[]>([]);
  readonly testLoading = signal(false);

  readonly specTypes = CUSTOM_FORMAT_SPEC_TYPES;

  /** i18n key of the first thing blocking a save, or null when the form is valid. */
  readonly formError = computed(() => {
    if (!this.formName().trim()) return 'settings.custom_formats.name_required';
    const specs = this.formSpecs();
    if (!specs.length) return 'settings.custom_formats.spec_required';
    if (specs.some((s) => !s.value.trim())) return 'settings.custom_formats.value_required';
    if (specs.some((s) => s.type === 'title_regex' && !isValidRegex(s.value)))
      return 'settings.custom_formats.regex_invalid';
    return null;
  });

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    try {
      const [list, langs] = await Promise.all([
        this.api.list(),
        this.profilesApi.getLanguageDefinitions(),
      ]);
      this.rows.set(list);
      this.languages.set(langs);
    } catch {
      this.listError.set(this.translate.instant('settings.custom_formats.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Null when the type takes free text. */
  valueOptions(type: CustomFormatSpecType): readonly string[] | null {
    if (type === 'language') return this.languages().map((l) => l.isoCode);
    return VALUE_OPTIONS[type] ?? null;
  }

  openCreate() {
    this.editingId.set(null);
    this.formName.set('');
    this.formScore.set(0);
    this.formSpecs.set([]);
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(cf: CustomFormat) {
    this.editingId.set(cf.id);
    this.formName.set(cf.name);
    this.formScore.set(cf.score);
    this.formSpecs.set(cf.specs.map((s) => ({ ...s })));
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  addSpec() {
    this.formSpecs.update((specs) => [
      ...specs,
      { type: 'title_regex', value: '', negate: false, required: false },
    ]);
  }

  removeSpec(index: number) {
    this.formSpecs.update((specs) => specs.filter((_, i) => i !== index));
  }

  updateSpec(index: number, patch: Partial<CustomFormatSpec>) {
    this.formSpecs.update((specs) => specs.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  /** A value from the previous vocabulary would never match the new type. */
  changeSpecType(index: number, type: CustomFormatSpecType) {
    this.updateSpec(index, { type, value: this.valueOptions(type)?.[0] ?? '' });
  }

  specInvalid(spec: CustomFormatSpec): boolean {
    if (!spec.value.trim()) return true;
    return spec.type === 'title_regex' && !isValidRegex(spec.value);
  }

  async save() {
    if (this.formError()) return;
    this.saving.set(true);
    try {
      const body = { name: this.formName().trim(), score: this.formScore(), specs: this.formSpecs() };
      const id = this.editingId();
      await (id == null ? this.api.create(body) : this.api.update(id, body));
      this.closeEditor();
      await this.reloadAll();
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  async runTest() {
    const title = this.testTitle().trim();
    if (!title) return;
    this.testLoading.set(true);
    try {
      const results = await this.api.testTitle(title, { freeleech: this.testFreeleech() });
      this.testResults.set(results);
    } finally {
      this.testLoading.set(false);
    }
  }

  async deleteRow(cf: CustomFormat) {
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.custom_formats.confirm_delete', {
          name: cf.name,
        }),
        variant: 'danger',
      }))
    )
      return;
    try {
      await this.api.remove(cf.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({
        title: this.translate.instant('common.error'),
        message: httpErr.error?.message ?? this.translate.instant('common.error'),
        variant: 'danger',
      });
    }
  }
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}
