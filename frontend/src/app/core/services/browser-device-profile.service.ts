import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

interface HdrPlugin {
  isSupported(): Promise<{ supported: boolean }>;
}
const Hdr = registerPlugin<HdrPlugin>('Hdr');

/**
 * Builds a DeviceProfile by probing actual browser capabilities via canPlayType()
 * and MediaSource.isTypeSupported(). Inspired by Jellyfin's browserDeviceProfile.js.
 */

export interface DirectPlayProfile {
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
}

export interface CodecCondition {
  codec: string;
  maxLevel?: number;
  profiles?: string[];
  maxBitDepth?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface DeviceProfile {
  directPlayProfiles: DirectPlayProfile[];
  codecConditions: CodecCondition[];
  maxStreamingBitrate: number;
  maxAudioChannels: number;
  supportsHlsFmp4: boolean;
  supportsHlsTs: boolean;
  supportsHdr: boolean;
}

@Injectable({ providedIn: 'root' })
export class BrowserDeviceProfileService {
  private cachedProfile: DeviceProfile | null = null;
  private nativeHdr: boolean | null = null;

  constructor() {
    // Pre-fetch native HDR capability (async, cached for later sync use)
    if (Capacitor.isNativePlatform()) {
      Hdr.isSupported()
        .then((r) => { this.nativeHdr = r.supported; })
        .catch(() => { this.nativeHdr = false; });
    }
  }

  /**
   * Build the device profile. Cached after first call.
   */
  getProfile(): DeviceProfile {
    if (this.cachedProfile) return this.cachedProfile;
    this.cachedProfile = this.buildProfile();
    return this.cachedProfile;
  }

  private buildProfile(): DeviceProfile {
    const video = document.createElement('video');
    const hasMSE = typeof MediaSource !== 'undefined' && !!MediaSource.isTypeSupported;

    // --- Detect supported containers ---
    const containers: string[] = [];
    if (this.testType(video, hasMSE, 'video/mp4')) containers.push('mp4', 'm4v', 'mov');
    if (this.testType(video, hasMSE, 'video/webm')) containers.push('webm');
    // MKV: browsers can NOT play MKV containers directly. Do NOT add 'mkv' here.
    // MKV files with supported codecs will be handled via DirectStream (remux to HLS)
    // by the StreamBuilder, which checks video/audio codec support independently.

    // --- Detect supported video codecs ---
    const videoCodecs: string[] = [];
    const codecConditions: CodecCondition[] = [];

    // H.264
    if (this.testCodec(video, hasMSE, 'video/mp4', 'avc1.42E01E')) {
      videoCodecs.push('h264', 'avc1');
      const maxLevel = this.probeH264Level(video, hasMSE);
      codecConditions.push({
        codec: 'h264',
        maxLevel,
        profiles: ['baseline', 'constrained baseline', 'main', 'high'],
        maxBitDepth: 8,
      });
    }

    // HEVC
    if (this.testCodec(video, hasMSE, 'video/mp4', 'hvc1.1.6.L120.B0') ||
        this.testCodec(video, hasMSE, 'video/mp4', 'hev1.1.6.L120.B0')) {
      videoCodecs.push('hevc', 'h265', 'hvc1', 'hev1');
      const maxLevel = this.probeHevcLevel(video, hasMSE);
      const maxBitDepth = this.testCodec(video, hasMSE, 'video/mp4', 'hvc1.2.4.L120.B0') ? 10 : 8;
      codecConditions.push({
        codec: 'hevc',
        maxLevel,
        profiles: maxBitDepth >= 10 ? ['main', 'main 10'] : ['main'],
        maxBitDepth,
      });
    }

    // AV1
    if (this.testCodec(video, hasMSE, 'video/mp4', 'av01.0.08M.08')) {
      videoCodecs.push('av1');
      const maxBitDepth = this.testCodec(video, hasMSE, 'video/mp4', 'av01.0.08M.10') ? 10 : 8;
      codecConditions.push({
        codec: 'av1',
        maxBitDepth,
        profiles: maxBitDepth >= 10 ? ['main', 'high'] : ['main'],
      });
    }

    // VP9
    if (this.testCodec(video, hasMSE, 'video/webm', 'vp09.00.10.08') ||
        this.testCodec(video, hasMSE, 'video/webm', 'vp9')) {
      videoCodecs.push('vp9');
    }

    // VP8
    if (this.testCodec(video, hasMSE, 'video/webm', 'vp8')) {
      videoCodecs.push('vp8');
    }

    // --- Detect supported audio codecs ---
    const audioCodecs: string[] = [];
    if (this.testCodec(video, hasMSE, 'audio/mp4', 'mp4a.40.2')) audioCodecs.push('aac');
    if (this.testCodec(video, hasMSE, 'audio/mpeg', '')) audioCodecs.push('mp3');
    if (this.testCodec(video, hasMSE, 'audio/mp4', 'ac-3')) audioCodecs.push('ac3');
    if (this.testCodec(video, hasMSE, 'audio/mp4', 'ec-3')) audioCodecs.push('eac3');
    if (this.testCodec(video, hasMSE, 'audio/mp4', 'opus') ||
        this.testCodec(video, hasMSE, 'audio/webm', 'opus')) audioCodecs.push('opus');
    if (this.testCodec(video, hasMSE, 'audio/mp4', 'flac') ||
        this.testCodec(video, hasMSE, 'audio/flac', '')) audioCodecs.push('flac');
    if (this.testCodec(video, hasMSE, 'audio/mp4', 'alac')) audioCodecs.push('alac');

    // --- Max audio channels ---
    let maxAudioChannels = 2;
    try {
      const ctx = new AudioContext();
      maxAudioChannels = ctx.destination.maxChannelCount || 2;
      ctx.close();
    } catch { /* fallback to stereo */ }

    // --- HLS support ---
    const supportsHlsTs = this.testType(video, false, 'application/x-mpegURL') ||
                           this.testType(video, false, 'application/vnd.apple.mpegurl');
    const supportsHlsFmp4 = hasMSE; // Shaka/hls.js can handle fMP4 via MSE

    // --- HDR support ---
    let supportsHdr: boolean;
    if (Capacitor.isNativePlatform()) {
      // Use native plugin result (pre-fetched in constructor). Default true if not yet resolved.
      supportsHdr = this.nativeHdr ?? true;
    } else {
      const hdrDisplay = typeof matchMedia !== 'undefined' && matchMedia('(dynamic-range: high)').matches;
      const has10bitCodec = codecConditions.some(c => (c.maxBitDepth ?? 0) >= 10);
      supportsHdr = hdrDisplay && has10bitCodec;
    }

    return {
      directPlayProfiles: [{
        containers,
        videoCodecs,
        audioCodecs,
      }],
      codecConditions,
      maxStreamingBitrate: 0, // 0 = no limit
      maxAudioChannels,
      supportsHlsFmp4,
      supportsHlsTs,
      supportsHdr,
    };
  }

  // ---------------------------------------------------------------------------
  // Probing helpers
  // ---------------------------------------------------------------------------

  private testType(video: HTMLVideoElement, hasMSE: boolean, mime: string): boolean {
    if (video.canPlayType(mime)) return true;
    if (hasMSE && MediaSource.isTypeSupported(mime)) return true;
    return false;
  }

  private testCodec(video: HTMLVideoElement, hasMSE: boolean, mime: string, codec: string): boolean {
    const full = codec ? `${mime}; codecs="${codec}"` : mime;
    if (video.canPlayType(full)) return true;
    if (hasMSE && MediaSource.isTypeSupported(full)) return true;
    return false;
  }

  /** Probe max H.264 level by testing progressively higher levels */
  private probeH264Level(video: HTMLVideoElement, hasMSE: boolean): number {
    // Level -> hex suffix in avc1 codec string
    const levels: [number, string][] = [
      [30, 'avc1.42001E'],   // 3.0
      [31, 'avc1.42001F'],   // 3.1
      [40, 'avc1.640028'],   // 4.0
      [41, 'avc1.640029'],   // 4.1
      [42, '64002A'],        // 4.2
      [50, 'avc1.640032'],   // 5.0
      [51, 'avc1.640033'],   // 5.1
      [52, 'avc1.640034'],   // 5.2
      [60, 'avc1.64003C'],   // 6.0
      [62, 'avc1.64003E'],   // 6.2
    ];
    let maxLevel = 30;
    for (const [level, codec] of levels) {
      if (this.testCodec(video, hasMSE, 'video/mp4', codec)) {
        maxLevel = level;
      } else {
        break;
      }
    }
    return maxLevel;
  }

  /** Probe max HEVC level */
  private probeHevcLevel(video: HTMLVideoElement, hasMSE: boolean): number {
    const levels: [number, string][] = [
      [120, 'hvc1.1.6.L120.B0'],  // 4.0
      [123, 'hvc1.1.6.L123.B0'],  // 4.1
      [150, 'hvc1.1.6.L150.B0'],  // 5.0
      [153, 'hvc1.1.6.L153.B0'],  // 5.1
      [156, 'hvc1.1.6.L156.B0'],  // 5.2
      [180, 'hvc1.1.6.L180.B0'],  // 6.0
      [186, 'hvc1.1.6.L186.B0'],  // 6.2
    ];
    let maxLevel = 120;
    for (const [level, codec] of levels) {
      if (this.testCodec(video, hasMSE, 'video/mp4', codec)) {
        maxLevel = level;
      } else {
        break;
      }
    }
    return maxLevel;
  }
}
