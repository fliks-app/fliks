import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { SubtitleSearchResult } from '../../../../core/services/api/subtitles-api.service';

@Component({
  selector: 'app-media-detail-subtitle-search-modal',
  imports: [TranslateModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-subtitle-search-modal.component.html',
})
export class MediaDetailSubtitleSearchModalComponent {
  readonly subSearchLang = input.required<string>();
  readonly subSearchLoading = input(false);
  readonly subSearchSearched = input(false);
  readonly subSearchResults = input<SubtitleSearchResult[]>([]);
  readonly subtitleActionBusy = input(false);

  readonly subSearchLangChange = output<string>();
  readonly search = output<void>();
  readonly download = output<SubtitleSearchResult>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }
}
