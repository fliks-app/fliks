import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * DaisyUI select with label + optional hint. Options are projected via
 * `<ng-content>` so the caller controls `[ngValue]` typing.
 *
 * <app-select-field [(value)]="formRoleId" [label]="'Rôle' | translate">
 *   @for (role of roles(); track role.id) {
 *     <option [ngValue]="role.id">{{ role.name }}</option>
 *   }
 * </app-select-field>
 */
@Component({
  selector: 'app-select-field',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './select-field.html',
})
export class SelectFieldComponent<T = unknown> {
  readonly value = model.required<T>();
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly disabled = input<boolean>(false);
  readonly size = input<'md' | 'sm'>('md');
}
