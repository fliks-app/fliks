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

/** Changelog + install dialog for the topbar update button. Reads everything
 *  from AppUpdateService; the action adapts to the platform (in-app install on
 *  desktop, external release link on web/.deb). */
@Component({
  selector: 'app-update-modal',
  imports: [DatePipe, TranslateModule, LucideDownload, LucideExternalLink, LucideRocket],
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  onAction(): void {
    void this.update.install();
  }
}
