import { Component, OnInit, computed, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideCircleAlert,
  LucideCircleCheck,
  LucideDownload,
  LucideExternalLink,
  LucideRocket,
  LucideTriangleAlert,
} from '@lucide/angular';
import { AppUpdateService } from '../../../core/services/app-update.service';
import { MarkdownPipe } from '../../../shared/pipes/markdown.pipe';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';

/** Full-page counterpart to the topbar update button, also showing the "up to date" and error states it hides; the action adapts via {@link AppUpdateService}. */
@Component({
  selector: 'app-update-settings',
  imports: [
    LocaleDatePipe,
    ToggleFieldComponent,
    TranslatePipe,
    MarkdownPipe,
    LucideCircleAlert,
    LucideCircleCheck,
    LucideDownload,
    LucideExternalLink,
    LucideRocket,
    LucideTriangleAlert,
  ],
  templateUrl: './update-settings.html',
})
export class UpdateSettingsPageComponent implements OnInit {
  readonly update = inject(AppUpdateService);

  /** A manual re-check only makes sense for the desktop self-updater and the
   *  admin server-version check; store-managed native apps have no in-app path. */
  readonly canCheck = computed(() => this.update.mode() !== 'none');
  readonly checking = computed(() => this.update.state() === 'checking');
  readonly upToDate = computed(() => this.update.state() === 'not-available');
  readonly downloading = computed(() => this.update.state() === 'downloading');
  readonly installing = computed(() => this.update.state() === 'downloaded');
  readonly hasError = computed(() => this.update.state() === 'error');

  /** Desktop builds that can self-install show "Install"; everything else
   *  (server mode, .deb, dev) shows an external "open release" link. */
  readonly canInstallInApp = computed(
    () => this.update.mode() === 'desktop' && this.update.canInstall(),
  );

  ngOnInit(): void {
    // Re-check when the page opens so the state reflects now, not the last
    // background poll. No-op in store-managed (`none`) mode.
    if (this.canCheck()) void this.update.check();
  }

  check(): void {
    void this.update.check();
  }

  action(): void {
    void this.update.install();
  }
}
