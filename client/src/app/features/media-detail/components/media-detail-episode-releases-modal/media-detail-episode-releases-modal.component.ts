import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { MovieRelease } from '../../../../core/services/api/media.service';
import { ReleasesTableComponent } from '../releases-table/releases-table.component';

@Component({
  selector: 'app-media-detail-episode-releases-modal',
  imports: [TranslateModule, ReleasesTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-episode-releases-modal.component.html',
})
export class MediaDetailEpisodeReleasesModalComponent {
  readonly selectedEpisodeId = input<number | null>(null);
  readonly epReleases = input<MovieRelease[]>([]);
  readonly epReleasesLoading = input(false);
  readonly epReleasesSearched = input(false);
  readonly epReleasesError = input('');
  readonly epGrabBusy = input<string | null>(null);
  readonly epGrabState = input<Map<string, 'ok' | 'error'>>(new Map());
  readonly canGrab = input(false);

  readonly grabEpisodeBest = output<void>();
  readonly grabEpisodeRelease = output<{ release: MovieRelease; index: number }>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }
}
