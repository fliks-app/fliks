import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { TrackDownloadGlyphComponent } from '../../shared/components/track-download-glyph/track-download-glyph';
import { formatDuration } from './music-utils';

/** The inside of a track row: a leading cell, the title over its artists, trailing cells and the duration. The row's button or link wraps it. */
@Component({
  selector: 'app-track-line',
  imports: [TranslatePipe, TrackDownloadGlyphComponent],
  templateUrl: './track-line.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackLineComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly explicit = input(false);
  readonly active = input(false);
  /** Shows the track's download state before the subtitle. */
  readonly itemId = input<number | null>(null);
  readonly durationSeconds = input<number | null>(null);
  protected readonly duration = computed(() => formatDuration(this.durationSeconds()));
}
