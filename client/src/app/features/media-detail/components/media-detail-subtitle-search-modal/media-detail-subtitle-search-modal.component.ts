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
import { LocalizeLanguagePipe } from '../../../../core/pipes/localize-language.pipe';
import { SubtitleSearchResult } from '../../../../core/services/api/subtitles-api.service';

@Component({
  selector: 'app-media-detail-subtitle-search-modal',
  imports: [TranslateModule, FormsModule, LocalizeLanguagePipe],
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

  // Languages offered to the subtitle search. The displayed label is
  // resolved via the localizeLanguage pipe so it matches what the player
  // shows on its audio/subtitle tracks.
  readonly languageCodes: readonly string[] = [
    'en', 'fr', 'de', 'es', 'it', 'pt', 'ja', 'ko', 'zh', 'ru',
    'ar', 'nl', 'pl', 'tr', 'sv', 'da', 'no', 'fi',
  ];

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }
}
