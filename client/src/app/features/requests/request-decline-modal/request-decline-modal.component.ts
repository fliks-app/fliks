import {
  Component,
  ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TvRowDirective } from '../../../shared/directives/tv-row.directive';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { ModalComponent } from '../../../shared/components/modal';

/** Canned declines; a chip fills the reason, which stays editable. */
const REASON_KEYS = ['in_library', 'not_available', 'not_suitable', 'no_space'] as const;

@Component({
  selector: 'app-request-decline-modal',
  imports: [ModalComponent, TvRowDirective, ModalFooterComponent, ModalHeaderComponent, FormsModule, TranslatePipe],
  templateUrl: './request-decline-modal.component.html',
})
export class RequestDeclineModalComponent {
  private readonly translate = inject(TranslateService);
  protected readonly reasons = REASON_KEYS.map((k) => `requests.decline_reason_${k}`);

  readonly requestId = input<number | null>(null);
  readonly reasonText = input<string>('');
  readonly submitBusy = input(false);

  readonly reasonTextChange = output<string>();
  readonly dismissed = output<void>();
  readonly submitted = output<void>();

  private readonly dialogEl = viewChild<string, ElementRef<HTMLDialogElement>>('dialog', { read: ElementRef });

  protected pick(key: string) {
    this.reasonTextChange.emit(this.translate.instant(key));
  }

  protected isPicked(key: string) {
    return this.reasonText() === this.translate.instant(key);
  }

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }
}
