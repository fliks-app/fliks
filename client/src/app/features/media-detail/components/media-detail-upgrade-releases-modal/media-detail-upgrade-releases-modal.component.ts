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
  selector: 'app-media-detail-upgrade-releases-modal',
  imports: [TranslateModule, ReleasesTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-upgrade-releases-modal.component.html',
})
export class MediaDetailUpgradeReleasesModalComponent {
  readonly upgradeReleases = input<MovieRelease[]>([]);
  readonly upgradeReleasesLoading = input(false);
  readonly upgradeReleasesSearched = input(false);
  readonly upgradeReleasesError = input('');
  readonly upgradeGrabBusy = input<string | null>(null);
  readonly upgradeGrabState = input<Map<string, 'ok' | 'error'>>(new Map());
  readonly canGrab = input(false);

  readonly grabUpgradeRelease = output<{ release: MovieRelease; index: number }>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }
}
