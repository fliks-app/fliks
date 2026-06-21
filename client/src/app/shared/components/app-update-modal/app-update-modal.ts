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
      .changelog-md h1, .changelog-md h2, .changelog-md h3 { font-weight: 700; margin: 0.75rem 0 0.35rem; line-height: 1.3; }
      .changelog-md h1 { font-size: 1.05rem; }
      .changelog-md h2 { font-size: 1rem; }
      .changelog-md h3 { font-size: 0.9rem; opacity: 0.85; }
      .changelog-md > :first-child { margin-top: 0; }
      .changelog-md ul, .changelog-md ol { padding-left: 1.25rem; margin: 0.35rem 0; list-style: revert; }
      .changelog-md li { margin: 0.15rem 0; }
      .changelog-md p { margin: 0.4rem 0; }
      .changelog-md a { color: var(--color-primary); text-decoration: underline; }
      .changelog-md code { font-family: monospace; background: rgba(127, 127, 127, 0.18); padding: 0 0.25rem; border-radius: 0.25rem; }
      .changelog-md hr { margin: 0.6rem 0; border-color: rgba(127, 127, 127, 0.3); }
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
