import {
  Component,
  input,
  model,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

export type InputFieldType =
  | 'text'
  | 'email'
  | 'password'
  | 'url'
  | 'number'
  | 'search';

/**
 * DaisyUI input with label + optional hint. Two-way `[(value)]`.
 *
 * <app-input-field
 *   [(value)]="seerrUrl"
 *   [label]="'URL' | translate"
 *   placeholder="http://seerr:5055" />
 */
@Component({
  selector: 'app-input-field',
  imports: [FormsModule],
  templateUrl: './input-field.html',
})
export class InputFieldComponent {
  readonly value = model.required<string>();
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly placeholder = input<string>('');
  readonly type = input<InputFieldType>('text');
  readonly disabled = input<boolean>(false);
  readonly size = input<'md' | 'sm'>('md');
}
