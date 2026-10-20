import {
  Component,
  ElementRef,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideDownload,
  LucideExternalLink,
  LucideRocket,
  LucideTriangleAlert,
} from '@lucide/angular';
import { AppUpdateService } from '../../../core/services/app-update.service';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { ModalHeaderComponent } from '../modal-header';
import { ModalFooterComponent } from '../modal-footer';

/** Changelog + install dialog for the topbar update button, reading AppUpdateService; install is in-app on desktop, a release link on web/.deb. */
@Component({
  selector: 'app-update-modal',
  imports: [
    ModalFooterComponent,
    LocaleDatePipe,
    TranslatePipe,
    MarkdownPipe,
    LucideDownload,
    LucideExternalLink,
    LucideRocket,
    LucideTriangleAlert,
    ModalHeaderComponent,
  ],
  templateUrl: './app-update-modal.html',
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

  hideUntilServerUpdates(): void {
    this.update.hideUntilServerUpdates();
    this.close();
  }

  onAction(): void {
    void this.update.install();
  }
}
