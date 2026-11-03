import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import type { Family } from '../../../core/enums/family.enum';

export const QUALITY_FAMILIES: readonly Family[] = ['video', 'audio', 'text'];

@Component({
  selector: 'app-family-tabs',
  imports: [TranslatePipe],
  templateUrl: './family-tabs.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FamilyTabsComponent {
  readonly value = input.required<Family>();
  readonly valueChange = output<Family>();
  readonly families = QUALITY_FAMILIES;
}
