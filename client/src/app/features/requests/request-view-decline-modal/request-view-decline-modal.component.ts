import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';

export interface RequestViewDeclinePayload {
  mediaTitle: string;
  reason: string;
}

@Component({
  selector: 'app-request-view-decline-modal',
  imports: [ModalFooterComponent, ModalHeaderComponent, TranslatePipe],
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
