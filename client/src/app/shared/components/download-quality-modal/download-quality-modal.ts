import {
  Component,
  ChangeDetectionStrategy,
  signal,
  input,
  output,
  inject,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  StreamingApiService,
  DownloadQuality,
} from '../../../core/services/api/streaming-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { desktopDownloaderOrNull } from '../../../core/plugins/desktop-downloader.bridge';
import { LucideDownload, LucideX } from '@lucide/angular';

@Component({
  selector: 'app-download-quality-modal',
  imports: [TranslateModule, LucideDownload, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="modal">
      <div class="modal-box max-w-sm">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">{{ 'downloads.choose_quality' | translate }}</h3>
          <button class="btn btn-ghost btn-sm btn-circle" (click)="close()">
            <svg lucideX class="h-4 w-4"></svg>
          </button>
        </div>

        @if (loading()) {
          <div class="flex justify-center py-6">
            <span class="loading loading-spinner loading-md"></span>
          </div>
        } @else {
          <div class="flex flex-col gap-2">
            @for (q of qualities(); track q.key) {
              <button
                class="btn btn-outline justify-between gap-3"
                [disabled]="downloading()"
                (click)="selectQuality(q.key)"
              >
                <span class="flex items-center gap-2">
                  <svg lucideDownload class="h-4 w-4"></svg>
                  {{ q.key === 'original' ? ('downloads.original' | translate) : q.key }}
                </span>
                <span class="text-xs opacity-60">{{ q.label.split('(')[1]?.replace(')', '') || '' }}</span>
              </button>
            }
          </div>

          @if (!isNative) {
            <div class="divider my-2"></div>
            <button
              class="btn btn-outline justify-start gap-2 w-full"
              [disabled]="downloading()"
              (click)="downloadOriginal()"
            >
              <svg lucideDownload class="h-4 w-4"></svg>
              {{ 'downloads.original_file' | translate }}
            </button>
            <p class="text-xs text-base-content/60 mt-1">
              {{ 'downloads.original_file_note' | translate }}
            </p>
          }
        }

        @if (downloading()) {
          <div class="mt-4">
            <progress class="progress progress-primary w-full" [value]="downloadProgress()" max="100"></progress>
            <p class="text-xs text-center mt-1 text-base-content/60">{{ downloadProgress() }}%</p>
          </div>
        }
      </div>
      <form method="dialog" class="modal-backdrop"><button (click)="close()">close</button></form>
    </dialog>
  `,
})
export class DownloadQualityModalComponent {
  private readonly streamingApi = inject(StreamingApiService);
  private readonly auth = inject(AuthService);

  /** Original-file download is a browser save-to-disk — hidden on native,
   *  which uses the ExoPlayer/AVAsset offline pipeline instead. */
  readonly isNative = Capacitor.isNativePlatform();
  /** Desktop (Electron) downloads the original file to disk via the shell, so
   *  the transcoded quality rungs don't apply — only the original is offered. */
  readonly isDesktop = !!desktopDownloaderOrNull();

  @ViewChild('dialog') dialogRef!: ElementRef<HTMLDialogElement>;

  readonly qualities = signal<DownloadQuality[]>([]);
  readonly loading = signal(false);
  readonly downloading = signal(false);
  readonly downloadProgress = signal(0);

  readonly download = output<{ mediaFileId: number; quality: string }>();

  private mediaFileId = 0;

  async open(mediaFileId: number) {
    this.mediaFileId = mediaFileId;
    this.loading.set(true);
    this.downloading.set(false);
    this.downloadProgress.set(0);
    this.dialogRef.nativeElement.showModal();
    try {
      const q = await this.streamingApi.getDownloadQualities(mediaFileId);
      this.qualities.set(q);
    } finally {
      this.loading.set(false);
    }
  }

  selectQuality(quality: string) {
    this.download.emit({ mediaFileId: this.mediaFileId, quality });
    this.close();
  }

  /** Stream the untouched source file straight to the browser's downloads.
   *  Mint a long-lived stream token first: the file can be several GB and a
   *  1h access token would expire on a resumed range request mid-download. */
  async downloadOriginal() {
    // Desktop: route the original through the Electron download-to-disk path
    // (the browser <a> save doesn't reliably attach in the Electron shell).
    if (this.isDesktop) {
      this.selectQuality('original');
      return;
    }
    await this.auth.ensureStreamToken();
    const url = this.streamingApi.getOriginalDownloadUrl(this.mediaFileId);
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    this.close();
  }

  close() {
    this.dialogRef.nativeElement.close();
  }
}
