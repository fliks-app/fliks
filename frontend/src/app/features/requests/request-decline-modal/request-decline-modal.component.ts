import { ChangeDetectionStrategy, Component, ElementRef, input, output, viewChild } from '@angular/core';
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

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }
}
