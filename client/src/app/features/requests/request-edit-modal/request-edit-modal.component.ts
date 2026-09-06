import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { TranslatePipe } from '@ngx-translate/core';
import { FliksRequestRow } from '../../../core/services/api/requests.service';
import { LibrarySummary } from '../../../core/services/api/libraries-api.service';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';

@Component({
  selector: 'app-request-edit-modal',
  imports: [TvSelectDirective, ModalFooterComponent, ModalHeaderComponent, FormsModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './request-edit-modal.component.html',
})
export class RequestEditModalComponent {
  readonly row = input<FliksRequestRow | null>(null);
  readonly qualityProfiles = input<{ id: number; name: string }[]>([]);
  readonly languageProfiles = input<{ id: number; name: string }[]>([]);
  /** Libraries compatible with this request's media type that the caller can
   *  target — the picker is offered only when more than one is available. */
  readonly libraries = input<LibrarySummary[]>([]);
  readonly qualityProfileId = input<number | null>(null);
  readonly languageProfileId = input<number | null>(null);
  readonly libraryId = input<number | null>(null);
  readonly saving = input(false);

  readonly qualityProfileIdChange = output<number | null>();
  readonly languageProfileIdChange = output<number | null>();
  readonly libraryIdChange = output<number | null>();
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
