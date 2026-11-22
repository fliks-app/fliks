import {
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalComponent } from '../../../shared/components/modal';

export interface RequestViewDeclinePayload {
  mediaTitle: string;
  reason: string;
}

@Component({
  selector: 'app-request-view-decline-modal',
  imports: [ModalComponent, ModalHeaderComponent, TranslatePipe],
  templateUrl: './request-view-decline-modal.component.html',
})
export class RequestViewDeclineModalComponent {
  readonly payload = input<RequestViewDeclinePayload | null>(null);
  readonly dismissed = output<void>();

  private readonly dialogEl = viewChild<string, ElementRef<HTMLDialogElement>>('dialog', { read: ElementRef });

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }
}
