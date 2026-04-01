import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  AutoApprovalApiService,
  AutoApprovalRule,
  RuleCondition,
} from '../../../core/services/api/auto-approval-api.service';

const EMPTY_CONDITION = (): RuleCondition => ({
  field: 'role',
  operator: 'equals',
  value: '',
});

@Component({
  selector: 'app-auto-approval',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './auto-approval.html',
})
export class AutoApprovalSettingsComponent implements OnInit {
  private readonly api = inject(AutoApprovalApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly rules = signal<AutoApprovalRule[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly editorOpen = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly formEnabled = signal(true);
  readonly formPriority = signal(0);
  readonly formConditions = signal<RuleCondition[]>([EMPTY_CONDITION()]);

  readonly fields = ['role', 'genre', 'year', 'seasons', 'userId'];
  readonly operators = ['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains'];

  ngOnInit() {
    this.reload();
  }

  async reload() {
    this.loading.set(true);
    this.listError.set('');
    try {
      const list = await this.api.list();
      this.rules.set(list);
    } catch {
      this.listError.set(this.translate.instant('settings.auto_approval.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.editingId.set(null);
    this.formName.set('');
    this.formEnabled.set(true);
    this.formPriority.set(0);
    this.formConditions.set([EMPTY_CONDITION()]);
    this.saveError.set('');
    this.editorOpen.set(true);
  }

  openEdit(rule: AutoApprovalRule) {
    this.editingId.set(rule.id);
    this.formName.set(rule.name);
    this.formEnabled.set(rule.enabled);
    this.formPriority.set(rule.priority);
    this.formConditions.set(rule.conditions.map((c) => ({ ...c })));
    this.saveError.set('');
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
  }

  addCondition() {
    this.formConditions.update((list) => [...list, EMPTY_CONDITION()]);
  }

  removeCondition(i: number) {
    this.formConditions.update((list) => list.filter((_, idx) => idx !== i));
  }

  updateCondition(i: number, patch: Partial<RuleCondition>) {
    this.formConditions.update((list) =>
      list.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    );
  }

  async save() {
    const name = this.formName().trim();
    if (!name) {
      this.saveError.set(this.translate.instant('settings.auto_approval.name_required'));
      return;
    }
    this.saving.set(true);
    this.saveError.set('');
    const body = {
      name,
      enabled: this.formEnabled(),
      priority: this.formPriority(),
      conditions: this.formConditions(),
    };
    const id = this.editingId();
    try {
      await (id != null ? this.api.update(id, body) : this.api.create(body));
      this.editorOpen.set(false);
      await this.reload();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.saveError.set(
        httpErr.error?.message ?? this.translate.instant('settings.auto_approval.save_error'),
      );
    } finally {
      this.saving.set(false);
    }
  }

  async remove(rule: AutoApprovalRule) {
    if (
      !await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.auto_approval.confirm_delete', { name: rule.name }),
        variant: 'danger',
      })
    ) return;
    try {
      await this.api.remove(rule.id);
      this.rules.update((list) => list.filter((r) => r.id !== rule.id));
    } catch {
      // silently ignore
    }
  }
}
