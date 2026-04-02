import { ChangeDetectionStrategy, Component, ElementRef, input, output, viewChild } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

export interface RequestViewDeclinePayload {
  mediaTitle: string;
  reason: string;
}

@Component({
  selector: 'app-request-view-decline-modal',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './request-view-decline-modal.component.html',
})
export class RequestViewDeclineModalComponent {
  readonly payload = input<RequestViewDeclinePayload | null>(null);
  readonly dismissed = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }
}
