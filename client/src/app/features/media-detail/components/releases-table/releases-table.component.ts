import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
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

@Component({
  selector: 'app-releases-table',
  imports: [TranslateModule, LucideTriangleAlert, LucideCheck, LucideCircleAlert, LucideDownload, LucidePackage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './releases-table.component.html',
})
export class ReleasesTableComponent {
  private readonly translate = inject(TranslateService);

  readonly releases = input.required<MovieRelease[]>();
  readonly filteredReleases = computed(() => this.releases().filter((r) => r.allowed));
  readonly grabBusy = input<string | null>(null);
  readonly grabState = input<Map<string, 'ok' | 'error'>>(new Map());
  readonly canGrab = input(false);
  readonly grabPrefix = input('r');
  readonly showCfScore = input(true);

  readonly grab = output<{ release: MovieRelease; index: number }>();

  grabKey(i: number): string {
    return `${this.grabPrefix()}-${i}`;
  }

  rejectionText(rejections: { code: string; params?: Record<string, number | string> }[]): string {
    return rejections.map((r) => this.formatRejection(r)).join('\n');
  }

  formatRejection(r: { code: string; params?: Record<string, number | string> }): string {
    return formatReleaseRejection(this.translate, r);
  }

  formatBytes(bytes: number): string {
    return formatMediaDetailBytes(bytes);
  }
}
