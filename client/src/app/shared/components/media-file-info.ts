import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideVideo, LucideVolume2, LucideTrash2 } from '@lucide/angular';
import {
  MediaFileInfo,
  VideoStreamInfo,
  AudioStreamInfo,
} from '../../core/services/api/media.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { CollapsibleSectionComponent } from './collapsible-section/collapsible-section';

type FileInput = {
  relativePath: string;
  size: number;
  quality: string;
  streamInfo?: MediaFileInfo | null;
};

@Component({
  selector: 'app-media-file-info',
  imports: [TranslateModule, CollapsibleSectionComponent, LucideVideo, LucideVolume2, LucideTrash2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-file-info.html',
})
export class MediaFileInfoComponent {
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  readonly file = input.required<FileInput | null>();
  /** Absolute folder path of the parent media (library.path + folderName).
   *  Concatenated with `file.relativePath` so the panel exposes the
   *  full disk path instead of a basename-like fragment. */
  readonly mediaPath = input<string | null>(null);

  /** Viewer holds the delete permission: exposes the delete-file action at the
   *  bottom of the panel. */
  readonly canDelete = input(false);
  /** Id of the file this panel describes, required to delete it. */
  readonly fileId = input<number | null>(null);
  readonly deleteFile = output<{ fileId: number; deleteOnDisk: boolean }>();

  async onDeleteFileClick() {
    const id = this.fileId();
    if (id == null) return;
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('media_detail.confirm_delete_file_disk'),
      variant: 'danger',
    });
    if (!confirmed) return;
    this.deleteFile.emit({ fileId: id, deleteOnDisk: true });
  }

  readonly videoStream = computed(() => this.file()?.streamInfo?.video[0] ?? null);
  readonly audioStreams = computed(() => this.file()?.streamInfo?.audio ?? []);

  /** SDR / HDR10 / HLG / Dolby Vision, from the probed HDR format + DV profile. */
  readonly videoRange = computed(() => {
    const v = this.videoStream();
    if (!v) return '';
    if (v.dvProfile != null) return 'Dolby Vision';
    return v.hdrFormat ?? 'SDR';
  });

  readonly fullPath = computed(() => {
    const f = this.file();
    if (!f?.relativePath) return '';
    const base = this.mediaPath();
    if (!base) return f.relativePath;
    const sep = base.endsWith('/') ? '' : '/';
    return `${base}${sep}${f.relativePath}`;
  });

  /** Container bitrate from ffprobe, or estimated from file size and duration. */
  readonly originalFileBitrate = computed(() => {
    const f = this.file();
    if (!f?.streamInfo) return undefined;
    const si = f.streamInfo;
    const fromFfprobe = si.formatBitRate;
    if (fromFfprobe && fromFfprobe > 0) return fromFfprobe;
    const dur = si.durationSeconds;
    if (f.size && dur && dur > 0) return Math.round((f.size * 8) / dur);
    return undefined;
  });

  formatSize(bytes?: number): string {
    const n = Number(bytes);
    if (!n || n <= 0) return '0 GB';
    if (n >= 1_073_741_824) return (n / 1_073_741_824).toFixed(2) + ' GB';
    if (n >= 1_048_576) return (n / 1_048_576).toFixed(1) + ' MB';
    return (n / 1024).toFixed(0) + ' KB';
  }

  formatBitrate(bps?: number): string {
    if (!bps) return '';
    if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(1) + ' Mbps';
    if (bps >= 1_000) return (bps / 1_000).toFixed(0) + ' kbps';
    return bps + ' bps';
  }

  formatResolution(v: VideoStreamInfo): string {
    if (!v.width || !v.height) return '';
    let s = `${v.width}\u00d7${v.height}`;
    if (v.displayAspectRatio) s += ` (${v.displayAspectRatio})`;
    return s;
  }

  formatAspectRatio(v: VideoStreamInfo): string {
    const crop = (v as any).crop;
    if (crop) {
      const ratio = (crop.width / crop.height).toFixed(2);
      return `${ratio}:1 (${crop.width}\u00d7${crop.height} — crop auto)`;
    }
    if (v.width && v.height) {
      const ratio = (v.width / v.height).toFixed(2);
      return `${ratio}:1`;
    }
    return v.displayAspectRatio ?? '';
  }

  /** e.g. "Profil 8.1 (compatible HDR10)". The base-layer compatibility id
   *  labels the fallback signal: 1 = HDR10, 2 = SDR, 4 = HLG. */
  formatDolbyProfile(v: VideoStreamInfo): string {
    if (v.dvProfile == null) return '';
    const compat = v.dvBlSignalCompatId;
    const word = this.translate.instant('file_info.profile');
    const base = compat ? `${word} ${v.dvProfile}.${compat}` : `${word} ${v.dvProfile}`;
    const key = { 1: 'hdr10', 2: 'sdr', 4: 'hlg' }[compat ?? 0];
    return key ? `${base} (${this.translate.instant('file_info.dolby_compat_' + key)})` : base;
  }

  formatChannels(a: AudioStreamInfo): string {
    if (a.channelLayout) return a.channelLayout;
    if (!a.channels) return '';
    const map: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' };
    return map[a.channels] ?? `${a.channels} ch`;
  }

  formatSampleRate(rate?: number): string {
    if (!rate) return '';
    return (rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1) + ' kHz';
  }

  formatAudioTitle(a: AudioStreamInfo): string {
    const parts = [a.codec.toUpperCase()];
    if (a.channelLayout) parts.push(this.formatChannels(a));
    else if (a.channels) parts.push(this.formatChannels(a));
    return parts.join(' ');
  }
}
