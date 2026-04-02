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
import {
  CustomFormatsApiService,
  CustomFormat,
  CustomFormatSpec,
} from '../../../core/services/api/custom-formats-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';

@Component({
  selector: 'app-custom-formats-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './custom-formats.html',
})
export class CustomFormatsSettingsComponent implements OnInit {
  private readonly api = inject(CustomFormatsApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly rows = signal<CustomFormat[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly saving = signal(false);

  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly formScore = signal(0);
  readonly formSpecs = signal<CustomFormatSpec[]>([]);

  readonly testTitle = signal('');
  readonly testResults = signal<{ formatId: number; formatName: string; matched: boolean; score: number }[]>([]);
  readonly testLoading = signal(false);

  readonly specTypes = ['title_regex', 'source', 'resolution', 'language', 'indexer_flag'] as const;
  readonly indexerFlagValues = ['freeleech', 'halfleech'] as const;

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    try {
      const list = await this.api.list();
      this.rows.set(list);
    } catch {
      this.listError.set(this.translate.instant('settings.custom_formats.load_error'));
    } finally {
      this.loading.set(false);
    }
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
    this.formSpecs.update((specs) =>
      specs.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    );
  }

  async save() {
    const name = this.formName().trim();
    if (!name) return;
    this.saving.set(true);
    const body = {
      name,
      score: this.formScore(),
      specs: this.formSpecs(),
    };
    const id = this.editingId();
    try {
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
      const results = await this.api.testTitle(title);
      this.testResults.set(results);
    } finally {
      this.testLoading.set(false);
    }
  }

  async deleteRow(cf: CustomFormat) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('settings.custom_formats.confirm_delete', { name: cf.name }), variant: 'danger' })) return;
    try {
      await this.api.remove(cf.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Error', variant: 'danger' });
    }
  }
}
