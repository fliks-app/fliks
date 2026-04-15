import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { LucideBookmark, LucideVideo, LucideVolume2 } from '@lucide/angular';
import {
  MediaFileInfo,
  VideoStreamInfo,
  AudioStreamInfo,
} from '../../core/services/api/media.service';

type FileInput = {
  relativePath: string;
  size: number;
  quality: string;
  streamInfo?: MediaFileInfo | null;
};

@Component({
  selector: 'app-media-file-info',
  imports: [TranslateModule, LucideBookmark, LucideVideo, LucideVolume2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-file-info.html',
})
export class MediaFileInfoComponent {
  readonly file = input.required<FileInput | null>();

  readonly videoStream = computed(() => this.file()?.streamInfo?.video[0] ?? null);
  readonly audioStreams = computed(() => this.file()?.streamInfo?.audio ?? []);
  readonly chapters = computed(() => this.file()?.streamInfo?.chapters ?? []);

  formatChapterTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

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
