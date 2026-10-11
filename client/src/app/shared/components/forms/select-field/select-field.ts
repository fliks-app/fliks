import {
  Component,
  input,
  model,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../directives/tv-select.directive';

/**
 * DaisyUI select with label + optional hint. Options are projected via
 * `<ng-content>`; use `[value]` (string): `[ngValue]` cannot reach the inner select.
 *
 * <app-select-field [(value)]="formRoleId" [label]="'Rôle' | translate">
 *   @for (role of roles(); track role.id) {
 *     <option [value]="role.id">{{ role.name }}</option>
 *   }
 * </app-select-field>
 */
@Component({
  selector: 'app-select-field',
  imports: [TvSelectDirective, FormsModule],
  templateUrl: './select-field.html',
})
export class SelectFieldComponent<T = unknown> {
  readonly value = model.required<T>();
  readonly label = input.required<string>();
  /** Keeps the label for screen readers only. */
  readonly hideLabel = input(false);
  readonly hint = input<string>();
  readonly disabled = input<boolean>(false);
  readonly size = input<'md' | 'sm'>('md');
}
