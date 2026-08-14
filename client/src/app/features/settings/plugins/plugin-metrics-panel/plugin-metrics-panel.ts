import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import type { PluginMetricsEntry } from '../../../../core/services/api/plugins-api.service';

/** One plugin's row from `GET /plugins/metrics`. `entry().metrics` is null for a `data`
 *  plugin or a `process` plugin that isn't running — rendered as "not applicable", never as zeros. */
@Component({
  selector: 'app-plugin-metrics-panel',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugin-metrics-panel.html',
})
export class PluginMetricsPanelComponent {
  readonly entry = input.required<PluginMetricsEntry>();

  /** Matches the MB formatting already used in `libraries.ts` / `streaming.ts`. */
  formatBytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
