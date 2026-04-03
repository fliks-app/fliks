import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
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
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-file-info.html',
})
export class MediaFileInfoComponent {
  readonly file = input.required<FileInput | null>();

  readonly videoStream = computed(() => this.file()?.streamInfo?.video[0] ?? null);
  readonly audioStreams = computed(() => this.file()?.streamInfo?.audio ?? []);

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
