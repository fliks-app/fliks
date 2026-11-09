import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideEllipsisVertical } from '@lucide/angular';
import { TranslatePipe } from '@ngx-translate/core';
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
import { HorizontalScrollerComponent } from '../../../shared/components/horizontal-scroller';
import { MediaCardComponent } from '../../../shared/components/media-card/media-card';
import { PluginInspectReport, PluginsApiService } from '../../../core/services/api/plugins-api.service';
import { keepRouteFresh } from '../../../core/services/keep-route-fresh';
import { PluginInstallConsentComponent } from './plugin-install-consent/plugin-install-consent';
import { PluginSourcesComponent } from './plugin-sources/plugin-sources';
import { PluginSettingsComponent } from './plugin-settings/plugin-settings';
import { PluginsState, pluginPosterName } from './plugins-state';

@Component({
  selector: 'app-plugins-settings',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    LucideEllipsisVertical,
    TranslatePipe,
    DropdownMenuComponent,
    HorizontalScrollerComponent,
    MediaCardComponent,
    PluginInstallConsentComponent,
    PluginSettingsComponent,
    PluginSourcesComponent,
  ],
  templateUrl: './plugins.html',
})
export class PluginsSettingsComponent implements OnInit {
  private readonly api = inject(PluginsApiService);
  protected readonly state = inject(PluginsState);

  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly consentSheet = viewChild<PluginInstallConsentComponent>('consentSheet');
  private readonly sourcesDialog = viewChild<PluginSourcesComponent>('sourcesDialog');
  private readonly settingsDialog = viewChild<PluginSettingsComponent>('settingsDialog');

  readonly uploading = signal(false);
  protected readonly posterName = pluginPosterName;
  // Cached so the card is still stamped when its detail page morphs back into it.
  private readonly routeFresh = keepRouteFresh({ refresh: () => void this.state.reload() });

  /** Built once per entry list, so a card's menu input only changes with its plugin. */
  readonly actionsById = computed(() => {
    const open = (report: PluginInspectReport) => this.consentSheet()?.open(report);
    return new Map(this.state.installed().map((e) => [e.id, this.state.actionsFor(e, open)]));
  });

  ngOnInit(): void {
    void this.state.reload();
  }

  pickFile(): void {
    this.fileInput()?.nativeElement.click();
  }

  /** Inspect uploads to staging regardless of outcome; the consent sheet renders either the consent UI or the refusal. */
  async onFilePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.uploading.set(true);
    try {
      this.consentSheet()?.open(await this.api.inspect(file));
    } catch {
      // The global error interceptor already toasts the server's message.
    } finally {
      this.uploading.set(false);
    }
  }

  openSources(): void {
    this.sourcesDialog()?.open();
  }

  openSettings(): void {
    void this.settingsDialog()?.open();
  }
}
