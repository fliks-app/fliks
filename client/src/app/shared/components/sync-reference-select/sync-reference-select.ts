import { Component, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { TvSelectDirective } from '../../directives/tv-select.directive';
import { LocalizeLanguagePipe } from '../../../core/pipes/localize-language.pipe';
import { SubtitleStatusPipe } from '../../../core/pipes/subtitle-status.pipe';
import type { MediaStream, SubtitleFileRow } from '../../../core/services/api/subtitles-api.service';

/** Reference picker for a subtitle sync: auto, an audio/subtitle stream, or an external subtitle file. */
@Component({
  selector: 'app-sync-reference-select',
  imports: [FormsModule, TranslatePipe, TvSelectDirective, LocalizeLanguagePipe, SubtitleStatusPipe],
  templateUrl: './sync-reference-select.html',
})
export class SyncReferenceSelectComponent {
  readonly value = model('auto');
  readonly audioStreams = input<MediaStream[]>([]);
  readonly subtitleStreams = input<MediaStream[]>([]);
  readonly externalRefs = input<SubtitleFileRow[]>([]);
}
