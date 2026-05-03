import { ChangeDetectionStrategy, Component, ElementRef, input, output, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { FliksRequestRow } from '../../../core/services/api/requests.service';

@Component({
  selector: 'app-request-edit-modal',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './request-edit-modal.component.html',
})
export class RequestEditModalComponent {
  readonly row = input<FliksRequestRow | null>(null);
  readonly qualityProfiles = input<{ id: number; name: string }[]>([]);
  readonly languageProfiles = input<{ id: number; name: string }[]>([]);
  readonly qualityProfileId = input<number | null>(null);
  readonly languageProfileId = input<number | null>(null);
  readonly saving = input(false);

  readonly qualityProfileIdChange = output<number | null>();
  readonly languageProfileIdChange = output<number | null>();
  readonly dismissed = output<void>();
  readonly save = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }
}
