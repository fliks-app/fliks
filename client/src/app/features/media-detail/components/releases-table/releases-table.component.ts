import {
  Component,
  inject,
  input,
  output,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LucideTriangleAlert,
  LucideCheck,
  LucideCircleAlert,
  LucideDownload,
  LucidePackage,
} from '@lucide/angular';
import { MovieRelease } from '../../media-detail-release-picker.service';
import { formatMediaDetailBytes } from '../../media-detail.utils';
import { formatReleaseRejection } from '../../media-detail-release.utils';
import { safeExternalUrl } from '../../../../shared/utils/safe-url';
import { ConfirmationService } from '../../../../core/services/confirmation.service';

@Component({
  selector: 'app-releases-table',
  imports: [TranslatePipe, LucideTriangleAlert, LucideCheck, LucideCircleAlert, LucideDownload, LucidePackage],
  templateUrl: './releases-table.component.html',
})
export class ReleasesTableComponent {
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly releases = input.required<MovieRelease[]>();
  readonly grabBusy = input<string | null>(null);
  readonly grabState = input<Map<string, 'ok' | 'error'>>(new Map());
  readonly canGrab = input(false);
  readonly grabPrefix = input('r');
  readonly showCfScore = input(true);

  readonly grab = output<{ release: MovieRelease; key: string }>();

  /** Keyed by `downloadUrl`, never by row position: the list re-ranks while a streamed
   *  search fills in, and a tab shows a subset — a positional key would move an in-flight
   *  grab's spinner, and its result, onto an unrelated release. */
  grabKey(r: MovieRelease): string {
    return `${this.grabPrefix()}-${r.downloadUrl}`;
  }

  /** An allowed release grabs straight away; a rejected one confirms first,
   *  naming the reason, since it bypasses the profile guard by hand. */
  async onGrabClick(r: MovieRelease): Promise<void> {
    if (!r.allowed) {
      const ok = await this.confirmation.confirm({
        title: this.translate.instant('media_detail.grab_rejected_confirm_title'),
        message: this.translate.instant('media_detail.grab_rejected_confirm', { reason: this.rejectionText(r.rejections) }),
        variant: 'warning',
      });
      if (!ok) return;
    }
    this.grab.emit({ release: r, key: this.grabKey(r) });
  }

  rejectionText(rejections: { code: string; params?: Record<string, number | string> }[]): string {
    return rejections.map((r) => this.formatRejection(r)).join('\n');
  }

  formatRejection(r: { code: string; params?: Record<string, number | string> }): string {
    return formatReleaseRejection(this.translate, r);
  }

  /** The tracker's own page for this release, when the feed named one and it is safe to link.
   *  Undefined renders the title as plain text rather than as a link that goes nowhere. */
  indexerPage(r: MovieRelease): string | undefined {
    return safeExternalUrl(r.infoUrl);
  }

  formatBytes(bytes: number): string {
    return formatMediaDetailBytes(bytes);
  }
}
