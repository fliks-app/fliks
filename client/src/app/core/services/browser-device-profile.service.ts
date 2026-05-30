import { Injectable, inject } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PlayerSettingsService } from './player-settings.service';
import { DeviceService } from './device.service';
import { getDeviceName } from '../utils/device-info';

interface HdrPlugin {
  isSupported(): Promise<{ supported: boolean }>;
}
const Hdr = registerPlugin<HdrPlugin>('Hdr');

interface AudioCapabilitiesPlugin {
  getSupported(): Promise<{ codecs: string[]; maxChannels: number }>;
}
const AudioCaps = registerPlugin<AudioCapabilitiesPlugin>('AudioCapabilities');

/** Probe Tizen's `webapis.avinfo.isHdrTvSupport()` synchronously. The
 *  Samsung runtime exposes a panel-level HDR capability flag that's
 *  more reliable than `matchMedia('(dynamic-range: high)')` on
 *  Chromium 85 (which often returns false even on Q-series HDR sets).
 *  Returns false on any non-Tizen target or when the API call throws,
 *  so the call site can fall back to the matchMedia path. */
function isTizenHdrCapable(): boolean {
  try {
    const w = window as unknown as {
      webapis?: { avinfo?: { isHdrTvSupport?: () => boolean } };
    };
    const fn = w.webapis?.avinfo?.isHdrTvSupport;
    return typeof fn === 'function' ? !!fn() : false;
  } catch {
    return false;
  }
}

/**
 * Builds a DeviceProfile by probing actual browser capabilities via canPlayType()
 * and MediaSource.isTypeSupported().
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
  supportsHdr: boolean;
  /** Client device category — selects the backend bitrate ladder.
   *  Capacitor native (iOS/Android app) → 'mobile'; web (incl. Cast sender) → 'desktop'. */
  deviceType: 'mobile' | 'desktop';
  /** Human-readable device shown on the admin streams dashboard
   *  ("Chrome — macOS", "iPhone"). Cosmetic only. */
  deviceName?: string;
  /** Hard force MPEG-TS HLS for every transcode session of this client.
   *  Defaults to `false`; the only switch in shipping configs is the
   *  narrower `useTsOnSingleAudio` below. Opt-in via
   *  `localStorage['fliks.useTs'] = '1'` as an emergency escape hatch
   *  for future firmware regressions. */
  useTs?: boolean;

  /** Force MPEG-TS only when the source has at most one audio track.
   *  Set by Tizen profiles: AVPlay HLS-fMP4 needs demuxed audio per
   *  Samsung spec, but with a single audio rendition AVPlay never
   *  engages the rendition probe and the variant stalls after the
   *  video init (issue #148 bisection). MPEG-TS muxes A+V natively,
   *  side-stepping the probe — at the cost of Dolby pass-through.
   *  Multi-audio Tizen sources stay on fMP4 + var_stream_map. */
  useTsOnSingleAudio?: boolean;

  /** Client consumes HLS `SUBTITLES` renditions from the master playlist
   *  natively (cues render inside the player pipeline, so they show in
   *  Picture-in-Picture / AirPlay). When false the backend omits the
   *  subtitle group and the client renders subtitles itself from a sidecar
   *  VTT. True for phone/desktop (iOS, Android, web/Shaka); false for TVs,
   *  whose AVPlay/webOS cue APIs are limited so they keep a DOM overlay. */
  supportsHlsSubtitles?: boolean;
}

/** True when `localStorage['fliks.useTs']` is set to a truthy value.
 *  See `DeviceProfile.useTs` for the rationale. */
function readUseTsOverride(): boolean {
  if (typeof localStorage === 'undefined') return false;
  const v = localStorage.getItem('fliks.useTs');
  return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

@Injectable({ providedIn: 'root' })
export class BrowserDeviceProfileService {
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly device = inject(DeviceService);
  private cachedProfile: DeviceProfile | null = null;
  private nativeHdr: boolean | null = null;
  private nativeAudio: { codecs: string[]; maxChannels: number } | null = null;

  constructor() {
    // Pre-fetch native HDR + audio capabilities (async, cached for later sync use)
    if (Capacitor.isNativePlatform()) {
      Hdr.isSupported()
        .then((r) => { this.nativeHdr = r.supported; })
        .catch(() => { this.nativeHdr = false; });
      AudioCaps.getSupported()
        .then((r) => { this.nativeAudio = r; this.cachedProfile = null; })
        .catch(() => { this.nativeAudio = null; });
    }
  }

  /**
   * Build the device profile. Cached after first call.
   */
  getProfile(): DeviceProfile {
    if (!this.cachedProfile) {
      this.cachedProfile = this.buildProfile();
      // Diagnostic: confirm the audio capabilities we'll send to the
      // backend on every playback request. Visible in chrome://inspect or
      // via `adb logcat -s chromium` on Capacitor Android.
      const dp = this.cachedProfile.directPlayProfiles[0];
      console.log(
        `[DeviceProfile] audioCodecs=${JSON.stringify(dp?.audioCodecs)} maxAudioChannels=${this.cachedProfile.maxAudioChannels} native=${Capacitor.isNativePlatform()}`,
      );
    }
    // Re-read mutable overrides on every call so toggling them at
    // runtime (HDR setting in the player UI, `fliks.useTs` escape
    // hatch in `localStorage`) doesn't require a page reload — the
    // next playback-info will pick up the change.
    const useTsOverride = readUseTsOverride();
    const forceDisableHdr = this.playerSettings.get().forceDisableHdr;
    const needsOverride =
      forceDisableHdr || useTsOverride !== !!this.cachedProfile.useTs;
    if (!needsOverride) return this.cachedProfile;
    return {
      ...this.cachedProfile,
      supportsHdr: forceDisableHdr ? false : this.cachedProfile.supportsHdr,
      useTs: useTsOverride,
    };
  }

  /** Whether the display hardware supports HDR (ignoring user preference). */
  get hardwareSupportsHdr(): boolean {
    if (!this.cachedProfile) this.cachedProfile = this.buildProfile();
    return this.cachedProfile.supportsHdr;
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

    // HEVC — re-enabled on Smart TV. AVPlay on Tizen 6.5 decodes HEVC
    // natively in HW; the earlier `InvalidAccessError` we attributed to
    // `hvc1` actually came from the master-playlist setup we've since
    // fixed (sequence, `setListener` ordering, MPEG-TS branch). Letting
    // the backend pick HEVC again skips a transcode for HEVC sources on
    // Q-series TVs.
    const isTv = this.device.isTv();
    const tvPlatform = this.device.tvPlatform();
    if (
      this.testCodec(video, hasMSE, 'video/mp4', 'hvc1.1.6.L120.B0') ||
      this.testCodec(video, hasMSE, 'video/mp4', 'hev1.1.6.L120.B0')
    ) {
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

    // AV1 — disabled on TV. Two unrelated reasons stack:
    //   1. Backend's `libsvtav1` rung is misconfigured (Max Bitrate <
    //      Target Bitrate → encoder exits 234), so any AV1 selection
    //      cascades into a 404 storm. Same bug we hit before reverting
    //      the AVPlay migration.
    //   2. AVPlay's HLS demuxer accepts AV1 in fMP4 but not consistently
    //      across firmware revisions — keeping it off the TV profile
    //      until we move to direct-play DASH.
    // Both go away on non-TV bundles where browser MSE drives playback.
    if (!isTv && this.testCodec(video, hasMSE, 'video/mp4', 'av01.0.08M.08')) {
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
    // On native, the platform plugin (AudioCapabilities) is the source of
    // truth — playback goes through ExoPlayer / AVPlayer, not the WebView,
    // so the WebView's canPlayType is irrelevant (and unreliable: some
    // WebViews report ec-3 positive on devices that have no decoder).
    let audioCodecs: string[];
    if (this.nativeAudio) {
      audioCodecs = [...this.nativeAudio.codecs];
    } else {
      audioCodecs = [];
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'mp4a.40.2')) audioCodecs.push('aac');
      if (this.testCodec(video, hasMSE, 'audio/mpeg', '')) audioCodecs.push('mp3');
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'ac-3')) audioCodecs.push('ac3');
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'ec-3')) audioCodecs.push('eac3');
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'opus') ||
          this.testCodec(video, hasMSE, 'audio/webm', 'opus')) audioCodecs.push('opus');
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'flac') ||
          this.testCodec(video, hasMSE, 'audio/flac', '')) audioCodecs.push('flac');
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'alac')) audioCodecs.push('alac');
    }

    // --- Max audio channels ---
    let maxAudioChannels = 2;
    try {
      const ctx = new AudioContext();
      maxAudioChannels = ctx.destination.maxChannelCount || 2;
      ctx.close();
    } catch { /* fallback to stereo */ }
    // Same reasoning as the codec override above: AudioContext exposes the
    // Same source as the codec list above — the native plugin reports
    // what the active output sink (HDMI / speakers / Bluetooth) accepts.
    if (this.nativeAudio) {
      maxAudioChannels = Math.max(maxAudioChannels, this.nativeAudio.maxChannels);
    }
    // webOS: the WebView's AudioContext caps at 2ch, but the native <video>
    // pipeline decodes Dolby and renders/passes it (TV speakers downmix, eARC
    // passes through). Declaring 5.1 when AC3/EAC3 is supported lets the
    // backend DirectStream multichannel Dolby instead of downmixing to stereo.
    if (
      tvPlatform === 'webos' &&
      (audioCodecs.includes('eac3') || audioCodecs.includes('ac3'))
    ) {
      maxAudioChannels = Math.max(maxAudioChannels, 6);
    }

    // --- HDR support ---
    let supportsHdr: boolean;
    if (Capacitor.isNativePlatform()) {
      // Use native plugin result (pre-fetched in constructor). Default true if not yet resolved.
      supportsHdr = this.nativeHdr ?? true;
    } else if (isTizenHdrCapable()) {
      // Tizen Smart TV: the panel-level capability is reported by
      // `webapis.avinfo.isHdrTvSupport()`. This bypasses the
      // `matchMedia('(dynamic-range: high)')` probe, which is
      // unreliable in Chromium 85 on TVs that DO support HDR (matchMedia
      // returns false even on Q-series sets). Combine with the
      // 10-bit codec check so we don't promise HDR on a Main-only
      // profile somehow.
      const has10bitCodec = codecConditions.some(c => (c.maxBitDepth ?? 0) >= 10);
      supportsHdr = has10bitCodec;
    } else {
      const hdrDisplay = typeof matchMedia !== 'undefined' && matchMedia('(dynamic-range: high)').matches;
      const has10bitCodec = codecConditions.some(c => (c.maxBitDepth ?? 0) >= 10);
      supportsHdr = hdrDisplay && has10bitCodec;
    }

    const useTs = readUseTsOverride();
    if (useTs) console.warn('[DeviceProfile] useTs override active');

    return {
      directPlayProfiles: [{
        containers,
        videoCodecs,
        audioCodecs,
      }],
      codecConditions,
      maxStreamingBitrate: 0, // 0 = no limit
      maxAudioChannels,
      supportsHdr,
      deviceType: Capacitor.isNativePlatform() ? 'mobile' : 'desktop',
      deviceName: getDeviceName(),
      useTs,
      // Tizen opts into MPEG-TS on single-audio sources (AVPlay's HLS-fMP4
      // rendition-probe stall, issue #148). Multi-audio sources stay on
      // fMP4 + var_stream_map — that path works because the master exposes
      // ≥2 audio renditions and AVPlay engages its probe. webOS, browser,
      // Cast and native mobile consume muxed fMP4 across the board (webOS's
      // native <video> has no such stall and fMP4 keeps Dolby pass-through).
      useTsOnSingleAudio: tvPlatform === 'tizen',
      // Phone/desktop clients (iOS AVPlayer, Android ExoPlayer, web Shaka)
      // consume the master SUBTITLES renditions natively, so cues render
      // inside the player (PiP / AirPlay / browser PiP). TVs stay false:
      // they have no PiP and their AVPlay/webOS cue APIs are limited, so the
      // Tizen/webOS engines keep their DOM overlay (fed by sidecar VTT).
      supportsHlsSubtitles: !isTv,
    };
  }

  // ---------------------------------------------------------------------------
  // Probing helpers
  // ---------------------------------------------------------------------------

  private testType(video: HTMLVideoElement, hasMSE: boolean, mime: string): boolean {
    if (hasMSE) return MediaSource.isTypeSupported(mime);
    return !!video.canPlayType(mime);
  }

  /** Codec support gate for the device profile sent to the backend.
   *
   *  Browser playback runs through Shaka + MSE, so the codec list MUST be
   *  what MSE.isTypeSupported accepts. `canPlayType` can return `"maybe"`
   *  for codecs MSE actually rejects (HEVC on Chrome Linux is the
   *  textbook case), and the truthy `"maybe"` would let the backend
   *  pick a codec that Chrome's SourceBuffer refuses at appendBuffer
   *  time — surfaces to the user as Shaka error 3014
   *  MEDIA_SOURCE_OPERATION_FAILED on every first segment. */
  private testCodec(video: HTMLVideoElement, hasMSE: boolean, mime: string, codec: string): boolean {
    const full = codec ? `${mime}; codecs="${codec}"` : mime;
    if (hasMSE) return MediaSource.isTypeSupported(full);
    return !!video.canPlayType(full);
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
