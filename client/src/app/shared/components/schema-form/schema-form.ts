import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { FieldDef } from '../../../core/plugin-ui/contribution.types';
import { InputFieldComponent, InputFieldType } from '../forms/input-field/input-field';
import { SelectFieldComponent } from '../forms/select-field/select-field';
import { ToggleFieldComponent } from '../forms/toggle-field/toggle-field';

/** Keyed by `FieldDef.key`; a select/text/number value is always a string here, coerced on read. */
export type SchemaFormValue = Record<string, string | number | boolean>;

type FieldKind = 'input' | 'toggle' | 'select';

/**
 * Renders a `FieldDef[]` as DaisyUI controls, delegating to the four shared
 * `forms/` components. An unmatched `field.type` renders nothing — it must
 * never blank out or break the rest of the form.
 *
 * `secret: true` fields: clearing one back to blank (or never touching it)
 * drops the key from `value` instead of writing `''`, so a save built from
 * `value()` never overwrites a stored credential with emptiness — the server
 * never echoes a secret back, so "blank" and "untouched" are indistinguishable
 * on purpose. `required` is not enforced on secret fields: the component has
 * no create/edit context to know whether blank means "unset" or "keep as is".
 */
@Component({
  selector: 'app-schema-form',
  imports: [InputFieldComponent, SelectFieldComponent, ToggleFieldComponent, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './schema-form.html',
})
export class SchemaFormComponent {
  readonly fields = input.required<readonly FieldDef[]>();
  readonly value = model.required<SchemaFormValue>();
  readonly disabled = input(false);

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
      default:
        return null;
    }
  }

  protected inputType(field: FieldDef): InputFieldType {
    return field.type as InputFieldType;
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

  protected isInvalid(field: FieldDef): boolean {
    if (!field.required || field.secret) return false;
    const v = this.value()[field.key];
    return v === undefined || v === null || String(v).trim() === '';
  }
}
