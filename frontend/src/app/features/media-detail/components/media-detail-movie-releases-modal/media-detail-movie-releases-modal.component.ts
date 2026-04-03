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
import { MovieRelease } from '../../../../core/services/api/media.service';
import { ReleasesTableComponent } from '../releases-table/releases-table.component';

@Component({
  selector: 'app-media-detail-movie-releases-modal',
  imports: [TranslateModule, FormsModule, ReleasesTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-movie-releases-modal.component.html',
})
export class MediaDetailMovieReleasesModalComponent {
  readonly customSearchQuery = input('');
  readonly releases = input<MovieRelease[]>([]);
  readonly releasesLoading = input(false);
  readonly releasesSearched = input(false);
  readonly releasesError = input('');
  readonly grabBusy = input<string | null>(null);
  readonly grabState = input<Map<string, 'ok' | 'error'>>(new Map());
  readonly canGrab = input(false);

  readonly customSearchQueryChange = output<string>();
  readonly grabRelease = output<{ release: MovieRelease; index: number }>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }
}
