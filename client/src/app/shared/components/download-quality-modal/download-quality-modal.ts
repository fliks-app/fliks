import {
  Component,
  signal,
  input,
  output,
  inject,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  StreamingApiService,
  DownloadQuality,
} from '../../../core/services/api/streaming-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { desktopDownloaderOrNull } from '../../../core/plugins/desktop-downloader.bridge';
import { LucideDownload, LucideX } from '@lucide/angular';
import { formatBytes } from '../../utils/download-format';

@Component({
  selector: 'app-download-quality-modal',
  imports: [TranslatePipe, LucideDownload, LucideX],
  templateUrl: './download-quality-modal.html',
})
export class DownloadQualityModalComponent {
  private readonly streamingApi = inject(StreamingApiService);
  private readonly auth = inject(AuthService);

  protected readonly formatBytes = formatBytes;

  /** Original-file download is a browser save-to-disk — hidden on native,
   *  which uses the ExoPlayer/AVAsset offline pipeline instead. */
  readonly isNative = Capacitor.isNativePlatform();
  /** Desktop (Electron) offers the same quality rungs; the original-file option
   *  routes through the shell's download-to-disk path rather than a browser save. */
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

  /** Stream the untouched source file to the downloads; mint a long-lived stream token since a 1h access token would expire on a resumed range request. */
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
