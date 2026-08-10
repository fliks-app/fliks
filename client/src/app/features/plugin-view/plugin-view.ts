import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideTriangleAlert } from '@lucide/angular';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';

type UnavailableReason = 'unknown_plugin' | 'unknown_view' | 'unsupported_kind';

/**
 * Resolves `plugins/:pluginId/:view` and the admin settings-page form to a
 * contribution. Rendering the `form`/`providers`/`table` view kinds ships in
 * later PRs — until then every resolution ends in a translated "unavailable"
 * state, never a blank page.
 */
@Component({
  selector: 'app-plugin-view',
  imports: [TranslateModule, LucideTriangleAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugin-view.html',
})
export class PluginViewComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly registry = inject(PluginUiRegistryService);

  // Angular reuses this component across param changes on the same route
  // config (same wildcard path, different pluginId/view) — read reactively.
  private readonly params = toSignal(this.route.paramMap);

  readonly pluginId = computed(() => this.params()?.get('pluginId') ?? '');
  readonly view = computed(() => this.params()?.get('view') ?? '');

  readonly reason = computed<UnavailableReason>(() => {
    if (!this.registry.hasPlugin(this.pluginId())) return 'unknown_plugin';
    if (!this.registry.configPage(this.pluginId(), this.view())) return 'unknown_view';
    return 'unsupported_kind';
  });
}
