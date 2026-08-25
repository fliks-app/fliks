import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { MovieRelease } from '../../media-detail-release-picker.service';
import { ReleasesTableComponent } from '../releases-table/releases-table.component';
import { DismissableStackService } from '../../../../core/services/dismissable-stack.service';

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

  readonly grab = output<{ release: MovieRelease; index: number }>();

  private readonly dismissStack = inject(DismissableStackService);
  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly closeCallback = () => this.dialogEl()?.nativeElement.close();

  showModal() {
    const el = this.dialogEl()?.nativeElement;
    if (!el || el.open) return;
    el.showModal();
    this.dismissStack.push(this.closeCallback);
    el.addEventListener('close', () => this.dismissStack.remove(this.closeCallback), { once: true });
  }
}
