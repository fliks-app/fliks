import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-request-decline-modal',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './request-decline-modal.component.html',
})
export class RequestDeclineModalComponent {
  readonly requestId = input<number | null>(null);
  readonly reasonText = input<string>('');
  readonly submitBusy = input(false);

  readonly reasonTextChange = output<string>();
  readonly dismissed = output<void>();
  readonly submitted = output<void>();
}
