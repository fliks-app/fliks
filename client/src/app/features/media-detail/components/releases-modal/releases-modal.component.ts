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
  selector: 'app-releases-modal',
  imports: [FormsModule, TranslateModule, ReleasesTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './releases-modal.component.html',
})
export class ReleasesModalComponent {
  readonly title = input.required<string>();
  readonly releases = input<MovieRelease[]>([]);
  readonly loading = input(false);
  readonly searched = input(false);
  readonly error = input('');
  readonly emptyMessage = input('media_detail.releases_empty');
  readonly grabBusy = input<string | null>(null);
  readonly grabState = input<Map<string, 'ok' | 'error'>>(new Map());
  readonly canGrab = input(true);
  readonly grabPrefix = input('r');
  readonly showCfScore = input(true);

  /** Show a custom search input (movie releases). */
  readonly showSearch = input(false);
  readonly customSearchQuery = input('');
  readonly customSearchQueryChange = output<string>();

  /** Show a "Grab Best" button (episode releases). */
  readonly showGrabBest = input(false);
  readonly grabBestDisabled = input(false);
  readonly grabBestBusy = input(false);
  readonly grabBest = output<void>();

  readonly grab = output<{ release: MovieRelease; index: number }>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  showModal() {
    this.dialogEl()?.nativeElement.showModal();
  }
}
