import { Component, OnInit, computed, inject, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { LucideChevronLeft } from '@lucide/angular';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PluginInspectReport } from '../../../../core/services/api/plugins-api.service';
import { ErrorBadgeComponent } from '../../../../shared/components/error-badge';
import { PluginMetricsPanelComponent } from '../plugin-metrics-panel/plugin-metrics-panel';
import { PluginInstallConsentComponent } from '../plugin-install-consent/plugin-install-consent';
import { trustBadgeFor } from '../plugin-trust';
import { statusBadgeFor, statusDetail } from '../plugin-status';
import { capabilityLabels } from '../plugin-capability';
import { PluginsState, pluginPosterName } from '../plugins-state';

/** One plugin, installed or offered by a catalog: what it is, what it may do, and its card's actions. */
@Component({
  selector: 'app-plugin-detail',
  imports: [
    RouterLink,
    LucideChevronLeft,
    TranslatePipe,
    ErrorBadgeComponent,
    PluginMetricsPanelComponent,
    PluginInstallConsentComponent,
  ],
  templateUrl: './plugin-detail.html',
})
export class PluginDetailComponent implements OnInit {
  private readonly translate = inject(TranslateService);
  protected readonly state = inject(PluginsState);
  protected readonly posterName = pluginPosterName;
  private readonly consentSheet = viewChild<PluginInstallConsentComponent>('consentSheet');

  private readonly pluginId = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => p.get('pluginId') ?? '')), {
    initialValue: '',
  });

  protected readonly entry = computed(() => this.state.entry(this.pluginId()));
  protected readonly actions = computed(() => {
    const e = this.entry();
    const open = (report: PluginInspectReport) => this.consentSheet()?.open(report);
    return e ? this.state.actionsFor(e, open, false) : [];
  });
  protected readonly metrics = computed(() => this.state.metricsByPluginId().get(this.pluginId()) ?? null);

  protected readonly trustBadgeFor = trustBadgeFor;
  protected readonly status = computed(() => {
    const row = this.entry()?.installed;
    return row ? statusBadgeFor(row) : null;
  });
  protected readonly statusDetail = computed(() => {
    const row = this.entry()?.installed;
    return row ? statusDetail(row) : null;
  });
  protected readonly description = computed(() => {
    const e = this.entry();
    return e ? this.state.descriptionFor(e) : '';
  });
  protected readonly author = computed(() => {
    const e = this.entry();
    return e?.installed?.author || e?.catalog?.plugin.author || '';
  });
  protected readonly capabilities = computed(() =>
    capabilityLabels(this.translate, this.entry()?.installed?.capabilities ?? []),
  );
  protected readonly heldDetail = computed(() => {
    const h = this.entry()?.installed?.heldUpdate;
    if (!h) return null;
    const key = h.reason === 'new-scopes' ? 'new_scopes' : 'failed';
    return this.translate.instant(`settings.plugins.held_update.${key}`, { version: h.version, detail: h.detail });
  });

  ngOnInit(): void {
    void this.state.reload();
  }

  hideBrokenLogo(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }
}
