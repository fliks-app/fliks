import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { LucideDownload, LucideExternalLink, LucideRocket } from '@lucide/angular';
import { AppUpdateService } from '../../../core/services/app-update.service';
import { MarkdownPipe } from '../../pipes/markdown.pipe';

/** Changelog + install dialog for the topbar update button. Reads everything
 *  from AppUpdateService; the action adapts to the platform (in-app install on
 *  desktop, external release link on web/.deb). */
@Component({
  selector: 'app-update-modal',
  imports: [DatePipe, TranslateModule, MarkdownPipe, LucideDownload, LucideExternalLink, LucideRocket],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-update-modal.html',
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
export class AppUpdateModalComponent {
  readonly update = inject(AppUpdateService);

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** True while the desktop app is downloading the update. */
  readonly downloading = computed(() => this.update.state() === 'downloading');
  /** True once downloaded — the app is about to relaunch to apply it. */
  readonly installing = computed(() => this.update.state() === 'downloaded');

  /** Desktop builds that can self-install show "Install"; everything else
   *  (server mode, .deb, dev) shows an external "open release" link. */
  readonly canInstallInApp = computed(
    () => this.update.mode() === 'desktop' && this.update.canInstall(),
  );

  open(): void {
    this.dialog()?.nativeElement.showModal();
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }

  onAction(): void {
    void this.update.install();
  }
}
