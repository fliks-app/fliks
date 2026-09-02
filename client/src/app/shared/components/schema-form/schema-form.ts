import { ChangeDetectionStrategy, Component, computed, inject, input, model } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FieldDef, FormCaption, FormGroup, FormItem, FormStatus } from '@fliks/plugin-contract/ui';
import { InputFieldComponent, InputFieldType } from '../forms/input-field/input-field';
import { SelectFieldComponent } from '../forms/select-field/select-field';
import { ToggleFieldComponent } from '../forms/toggle-field/toggle-field';
import { MultiSelectComponent, MultiSelectOption } from '../forms/multi-select/multi-select';

/** Keyed by `FieldDef.key`; a select/text/number value is always a string here, coerced on read.
 *  A `status` item's current value is keyed by its own `settingKey` in this same bag. */
export type SchemaFormValue = Record<string, string | number | boolean | null | string[]>;

/** Shown in place of a stored credential the server never echoes back. */
export const SECRET_MASK = '●●●●●●●●';

type FieldKind = 'input' | 'toggle' | 'select' | 'multiselect';
type ItemKind = 'field' | 'caption' | 'group' | 'status';

interface FieldError {
  key: string;
  params?: Record<string, unknown>;
}


/**
 * Renders a `FormItem[]` as DaisyUI controls, delegating to the shared
 * `forms/` components. An unmatched `field.type` renders nothing — it must
 * never blank out or break the rest of the form.
 *
 * `secret: true` fields: clearing one back to blank (or never touching it)
 * drops the key from `value` instead of writing `''`, so a save built from
 * `value()` never overwrites a stored credential with emptiness — the server
 * never echoes a secret back, so "blank" and "untouched" are indistinguishable
 * on purpose. `required` is not enforced on secret fields: the component has
 * no create/edit context to know whether blank means "unset" or "keep as is".
 *
 * `secretsSet` names the keys that already hold a stored value: those render
 * masked, with an erase action that writes `null` — the JSON Merge Patch
 * (RFC 7396) spelling of "remove this member".
 */
@Component({
  selector: 'app-schema-form',
  imports: [
    InputFieldComponent,
    SelectFieldComponent,
    ToggleFieldComponent,
    MultiSelectComponent,
    NgTemplateOutlet,
    TranslateModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './schema-form.html',
})
export class SchemaFormComponent {
  private readonly translate = inject(TranslateService);

  readonly fields = input.required<readonly FormItem[]>();
  readonly value = model.required<SchemaFormValue>();
  readonly disabled = input(false);
  /** Keys of `secret: true` fields the server reports as already set. */
  readonly secretsSet = input<readonly string[]>([]);

  /** True while a value breaks a declared constraint. A `required` field left empty is shown as a
   *  hint but does not hold here: clearing one is how an operator unsets it. */
  readonly invalid = computed(() =>
    this.flatFields().some((f) => this.fieldErrors(f).some((e) => e.key !== 'common.field_required')),
  );

  private flatFields(): FieldDef[] {
    const out: FieldDef[] = [];
    for (const item of this.fields()) {
      if (item.kind === 'group') out.push(...item.fields);
      else if (item.kind === undefined || item.kind === 'field') out.push(item);
    }
    return out;
  }

  protected itemKind(item: FormItem): ItemKind {
    if (item.kind === 'caption') return 'caption';
    if (item.kind === 'group') return 'group';
    if (item.kind === 'status') return 'status';
    return 'field';
  }

  protected asCaption(item: FormItem): FormCaption {
    return item as FormCaption;
  }

  protected asGroup(item: FormItem): FormGroup {
    return item as FormGroup;
  }

  protected asStatus(item: FormItem): FormStatus {
    return item as FormStatus;
  }

  protected statusValue(item: FormStatus): string {
    const v = this.value()[item.settingKey];
    return v === undefined || v === null ? '' : String(v);
  }

  protected fieldKind(field: FieldDef): FieldKind | null {
    switch (field.type) {
      case 'text':
      case 'email':
      case 'password':
      case 'url':
      case 'number':
        return 'input';
      case 'toggle':
        return 'toggle';
      case 'select':
        return 'select';
      case 'multiselect':
        return 'multiselect';
      default:
        return null;
    }
  }

  /** `field.options` translated into what `<app-multi-select>` renders. */
  protected multiOptions(field: FieldDef): MultiSelectOption<string>[] {
    return (field.options ?? []).map((o) => ({
      value: o.value,
      label: this.translate.instant(o.labelKey),
    }));
  }

  protected multiValue(field: FieldDef): string[] {
    const v = this.value()[field.key];
    return Array.isArray(v) ? v : [];
  }

  protected setMulti(field: FieldDef, next: string[]): void {
    this.value.set({ ...this.value(), [field.key]: next });
  }

  protected inputType(field: FieldDef): InputFieldType {
    return field.type as InputFieldType;
  }

  protected isSecretStored(field: FieldDef): boolean {
    return Boolean(field.secret) && this.secretsSet().includes(field.key);
  }

  /** `null` is the pending erase; a typed value or an undo replaces it. */
  protected isCleared(field: FieldDef): boolean {
    return this.value()[field.key] === null;
  }

  protected clearSecret(field: FieldDef): void {
    this.value.set({ ...this.value(), [field.key]: null });
  }

  /** Empty unless a stored credential is standing in for a real value. */
  protected secretMask(field: FieldDef): string {
    return this.isSecretStored(field) && !this.isCleared(field) ? SECRET_MASK : '';
  }

  protected fieldValue(field: FieldDef): string {
    const v = this.value()[field.key];
    return v === undefined || v === null ? '' : String(v);
  }

  protected fieldBool(field: FieldDef): boolean {
    const v = this.value()[field.key];
    // `Boolean('false')` is true, and a settings store hands back text.
    return typeof v === 'string' ? v === 'true' : Boolean(v);
  }

  protected setValue(field: FieldDef, raw: string): void {
    const next = { ...this.value() };
    if (field.secret && raw === '') {
      delete next[field.key];
    } else {
      next[field.key] = field.type === 'number' && raw !== '' ? Number(raw) : raw;
    }
    this.value.set(next);
  }

  protected setBool(field: FieldDef, v: boolean): void {
    this.value.set({ ...this.value(), [field.key]: v });
  }

  /** An empty optional field is not invalid: a constraint describes a value, and there isn't one. */
  protected fieldErrors(field: FieldDef): FieldError[] {
    if (field.secret) return [];
    const errors: FieldError[] = [];
    const raw = this.value()[field.key];
    const isEmpty = Array.isArray(raw)
      ? raw.length === 0
      : raw === undefined || raw === null || String(raw).trim() === '';
    if (field.required && isEmpty) errors.push({ key: 'common.field_required' });
    if (isEmpty || Array.isArray(raw)) return errors;

    const str = String(raw);
    if (field.type === 'number') {
      const n = Number(raw);
      if (field.min !== undefined && n < field.min) errors.push({ key: 'schema_form.min_value', params: { min: field.min } });
      if (field.max !== undefined && n > field.max) errors.push({ key: 'schema_form.max_value', params: { max: field.max } });
    } else {
      if (field.minLength !== undefined && str.length < field.minLength) {
        errors.push({ key: 'schema_form.min_length', params: { min: field.minLength } });
      }
      if (field.maxLength !== undefined && str.length > field.maxLength) {
        errors.push({ key: 'schema_form.max_length', params: { max: field.maxLength } });
      }
    }
    return errors;
  }

  protected isInvalid(field: FieldDef): boolean {
    return this.fieldErrors(field).length > 0;
  }
}
