import {
  Component,
  signal,
  computed,
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
import { LucideCircleCheck, LucideDownload, LucideTrash2, LucideX } from '@lucide/angular';
import { DownloadSettingsService } from '../../../core/services/download-settings.service';
import { pickRung } from '../../../core/services/download-manager.service';
import { formatBytes } from '../../utils/download-format';

@Component({
  selector: 'app-download-quality-modal',
  imports: [TranslatePipe, LucideCircleCheck, LucideDownload, LucideTrash2, LucideX],
  templateUrl: './download-quality-modal.html',
})
export class DownloadQualityModalComponent {
  private readonly streamingApi = inject(StreamingApiService);
  private readonly auth = inject(AuthService);
  private readonly settings = inject(DownloadSettingsService);

  protected readonly formatBytes = formatBytes;

  /** Original-file download is a browser save-to-disk — hidden on native,
   *  which uses the ExoPlayer/AVAsset offline pipeline instead. */
  readonly isNative = Capacitor.isNativePlatform();
  /** Desktop (Electron) offers the same quality rungs; the original-file option
   *  routes through the shell's download-to-disk path rather than a browser save. */
  readonly isDesktop = !!desktopDownloaderOrNull();

  @ViewChild('dialog') dialogRef!: ElementRef<HTMLDialogElement>;

  readonly qualities = signal<DownloadQuality[]>([]);
  /** Offered rung closest to the user's default; highlighted, not started. */
  readonly preselected = computed(() => {
    const key = this.settings.defaultQuality();
    return key ? (pickRung(this.qualities(), key)?.key ?? null) : null;
  });
  readonly loading = signal(false);
  readonly downloading = signal(false);
  readonly downloadProgress = signal(0);

  readonly download = output<{ mediaFileId: number; quality: string; unwatchedOnly: boolean }>();
  readonly remove = output<void>();
  /** Progress of the download under way for this file; null when none. */
  readonly progress = input<number | null>(null);

  private mediaFileId = 0;

  /** Quality of the download already on the device or under way; null for a fresh download. */
  readonly current = signal<string | null>(null);

  /** Batch mode (season or show): the episode counts the size and checkbox speak of; null for a single file. */
  readonly batch = signal<{ all: number; unwatched: number } | null>(null);
  readonly unwatchedOnly = signal(true);
  readonly batchCount = computed(() => {
    const b = this.batch();
    return b ? (this.unwatchedOnly() ? b.unwatched : b.all) : 1;
  });

  /** `mediaFileId` is the first episode's file, whose estimates stand for all of them. */
  openBatch(mediaFileId: number, counts: { all: number; unwatched: number }) {
    this.batch.set(counts);
    this.current.set(null);
    this.unwatchedOnly.set(true);
    return this.show(mediaFileId);
  }

  open(mediaFileId: number, current: string | null = null) {
    this.batch.set(null);
    this.current.set(current);
    return this.show(mediaFileId);
  }

  private async show(mediaFileId: number) {
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

  removeDownload() {
    this.remove.emit();
    this.close();
  }

  selectQuality(quality: string) {
    if (quality === this.current()) return this.close();
    this.download.emit({ mediaFileId: this.mediaFileId, quality, unwatchedOnly: this.unwatchedOnly() });
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
    await this.auth.ensureStreamToken(this.mediaFileId);
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
