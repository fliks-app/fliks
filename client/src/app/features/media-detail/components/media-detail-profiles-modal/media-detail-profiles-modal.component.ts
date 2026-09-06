import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';

@Component({
  selector: 'app-media-detail-profiles-modal',
  imports: [
    ModalFooterComponent,
    TranslatePipe,
    FormsModule,
    TvSelectDirective,
    ModalHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-profiles-modal.component.html',
})
export class MediaDetailProfilesModalComponent {
  readonly profilesOptionsLoading = input(false);
  readonly draftQualityProfileId = input<number | null>(null);
  readonly draftLanguageProfileId = input<number | null>(null);
  readonly qualityProfileOptions = input<{ id: number; name: string }[]>([]);
  readonly languageProfileOptions = input<{ id: number; name: string }[]>([]);
  readonly profilesOk = input('');
  readonly profilesErr = input('');
  readonly profilesSaveLoading = input(false);

  readonly draftQualityProfileIdChange = output<number | null>();
  readonly draftLanguageProfileIdChange = output<number | null>();
  readonly save = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }
}
