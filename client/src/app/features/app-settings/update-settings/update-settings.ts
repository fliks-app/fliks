import { Component, OnInit, computed, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideCircleAlert,
  LucideCircleCheck,
  LucideDownload,
  LucideExternalLink,
  LucideRocket,
} from '@lucide/angular';
import { AppUpdateService } from '../../../core/services/app-update.service';
import { MarkdownPipe } from '../../../shared/pipes/markdown.pipe';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';

/** Full-page counterpart to the topbar update button: shows the running
 *  version, lets the user re-check on demand, and surfaces the check result —
 *  including the "up to date" and error states the topbar button hides. Reads
 *  everything from {@link AppUpdateService}, so the action adapts to the
 *  platform (in-app install on desktop, external release link on web/.deb). */
@Component({
  selector: 'app-update-settings',
  imports: [
    LocaleDatePipe,
    TranslatePipe,
    MarkdownPipe,
    LucideCircleAlert,
    LucideCircleCheck,
    LucideDownload,
    LucideExternalLink,
    LucideRocket,
  ],
  templateUrl: './update-settings.html',
  styles: [
    `
      /* ::ng-deep — the changelog HTML is injected via [innerHTML], so it
         carries no encapsulation attribute and plain component styles miss it. */
      :host ::ng-deep .changelog-md { line-height: 1.55; }
      :host ::ng-deep .changelog-md > :first-child { margin-top: 0; }
      :host ::ng-deep .changelog-md h1,
      :host ::ng-deep .changelog-md h2 { font-size: 1.1rem; font-weight: 700; margin: 1rem 0 0.45rem; }
      :host ::ng-deep .changelog-md h3 { font-size: 0.95rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.75; margin: 0.9rem 0 0.35rem; }
      :host ::ng-deep .changelog-md ul,
      :host ::ng-deep .changelog-md ol { list-style: disc; padding-left: 1.4rem; margin: 0.4rem 0; }
      :host ::ng-deep .changelog-md ol { list-style: decimal; }
      :host ::ng-deep .changelog-md li { margin: 0.3rem 0; padding-left: 0.15rem; }
      :host ::ng-deep .changelog-md li::marker { color: var(--color-primary); }
      :host ::ng-deep .changelog-md p { margin: 0.5rem 0; }
      :host ::ng-deep .changelog-md a { color: var(--color-primary); text-decoration: underline; }
      :host ::ng-deep .changelog-md code { font-family: monospace; font-size: 0.85em; background: rgba(127, 127, 127, 0.18); padding: 0.05rem 0.3rem; border-radius: 0.25rem; }
      :host ::ng-deep .changelog-md hr { margin: 0.75rem 0; border: 0; border-top: 1px solid rgba(127, 127, 127, 0.3); }
    `,
  ],
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
