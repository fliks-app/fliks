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
  selector: 'app-media-detail-season-releases-modal',
  imports: [TranslateModule, ReleasesTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-season-releases-modal.component.html',
})
export class MediaDetailSeasonReleasesModalComponent {
  readonly seasonReleases = input<MovieRelease[]>([]);
  readonly seasonReleasesLoading = input(false);
  readonly seasonReleasesError = input('');
  readonly seasonGrabBusy = input<number | null>(null);
  readonly seasonReleaseGrabState = input<Map<string, 'ok' | 'error'>>(new Map());

  readonly grabSeasonRelease = output<{ release: MovieRelease; index: number }>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }
}
