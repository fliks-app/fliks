import { Injectable, inject } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PlayerSettingsService } from './player-settings.service';
import { DeviceService } from './device.service';
import { ServerConfigService } from './server-config.service';
import { ENGINE_TRAITS, engineKindFor } from './engine-traits';
import { SystemInfoService } from './system-info.service';
import { getDeviceName } from '../utils/device-info';

interface HdrPlugin {
  isSupported(): Promise<{ supported: boolean }>;
}
const Hdr = registerPlugin<HdrPlugin>('Hdr');

interface AudioCapabilitiesPlugin {
  getSupported(): Promise<{
    codecs: string[];
    maxChannels: number;
    /** Per-codec max decodable channel count (lowercased codec → channels).
     *  Lets the backend allow AAC 7.1 while downmixing EAC-3 7.1 on a device
     *  whose EAC-3 decoder tops out at 5.1. */
    channelsByCodec?: Record<string, number>;
  }>;
}
const AudioCaps = registerPlugin<AudioCapabilitiesPlugin>('AudioCapabilities');

interface NativeVideoCaps {
  videoCodecs: string[];
  hevcMain10: boolean;
  av1Main10: boolean;
  containers: string[];
  /** Per-codec max decodable resolution (codec key → {width, height}) from the
   *  device's MediaCodec VideoCapabilities. Absent on platforms whose plugin
   *  doesn't report it, leaving the codec unconstrained as before. */
  resolutions?: Record<string, { width: number; height: number }>;
}
interface VideoCapabilitiesPlugin {
  getSupported(): Promise<NativeVideoCaps>;
}
const VideoCaps = registerPlugin<VideoCapabilitiesPlugin>('VideoCapabilities');

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
  /** Per-audio-codec max decodable channels (lowercased codec → channels).
   *  Falls back to maxAudioChannels per codec on the backend. */
  audioChannelsByCodec?: Record<string, number>;
  supportsHdr: boolean;
  /** Client device category — selects the backend bitrate ladder.
   *  Capacitor native (iOS/Android app) → 'mobile'; web (incl. Cast sender) → 'desktop'. */
  deviceType: 'mobile' | 'desktop';
  /** Human-readable device shown on the admin streams dashboard
   *  ("Chrome — macOS", "iPhone"). Cosmetic only. */
  deviceName?: string;
  /** Real host OS name+version ("macOS 26", "iOS 18.5") resolved natively; the
   *  admin label prefers this over the UA-derived OS (which the UA freezes). */
  systemName?: string;
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

  /** Engine renders bitmap (PGS/VOBSUB) subtitles itself (ExoPlayer, mpv), so
   *  they're shown natively rather than burned into the video. False engines
   *  (web/Shaka, Tizen, webOS) burn them in. */
  supportsImageSubtitles?: boolean;

  /** Engine fetches seg-0 when it loads the playlist and then seeks to the
   *  resume point — true for the web/Shaka path (and the Cast receiver). The
   *  backend uses it to decide whether to pre-spawn the seg-0 early-start
   *  companion. Native engines (AVPlayer/ExoPlayer/AVPlay/webOS) seek straight
   *  to the target segment and never request seg-0, so they send false and the
   *  backend skips the companion (a wasted parallel transcode for them). */
  probesSegZero?: boolean;

  /** Client engine can play a raw progressive file (DirectPlay served as-is).
   *  True for Shaka (web), ExoPlayer/AVPlayer (native) and webOS `<video>`.
   *  False for Tizen AVPlay (HLS-only): the backend then never returns
   *  DirectPlay and falls back to DirectStream (remux to HLS). Unset = true. */
  supportsDirectPlay?: boolean;
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
  private readonly serverConfig = inject(ServerConfigService);
  private readonly systemInfo = inject(SystemInfoService);
  private cachedProfile: DeviceProfile | null = null;
  private nativeHdr: boolean | null = null;
  private nativeAudio: {
    codecs: string[];
    maxChannels: number;
    channelsByCodec?: Record<string, number>;
  } | null = null;
  private nativeVideo: NativeVideoCaps | null = null;

  constructor() {
    // Pre-fetch native HDR + audio + video capabilities (async, cached for
    // later sync use)
    if (Capacitor.isNativePlatform()) {
      Hdr.isSupported()
        .then((r) => { this.nativeHdr = r.supported; })
        .catch(() => { this.nativeHdr = false; });
      AudioCaps.getSupported()
        .then((r) => { this.nativeAudio = r; this.cachedProfile = null; })
        .catch(() => { this.nativeAudio = null; });
      VideoCaps.getSupported()
        .then((r) => { this.nativeVideo = r; this.cachedProfile = null; })
        .catch(() => { this.nativeVideo = null; });
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
    // systemName resolves asynchronously (native bridge / Capacitor Device), so
    // overlay the current value on every call rather than baking a possibly-empty
    // value into the cache.
    const systemName = this.systemInfo.systemName() || undefined;
    if (!needsOverride) return { ...this.cachedProfile, systemName };
    return {
      ...this.cachedProfile,
      systemName,
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
    // The four engine-behavioural flags below come from one declarative
    // row keyed on the engine kind (platform + native split). Adding a
    // platform is a single row in `engine-traits.ts`.
    const traits =
      ENGINE_TRAITS[
        engineKindFor(tvPlatform, this.serverConfig.isNative, this.device.isDesktopNative())
      ];
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

    // Native engines (Capacitor: ExoPlayer on Android, AVPlayer on iOS) decode
    // through the OS media stack, not the WebView — whose MSE under-reports
    // HEVC/AV1 on Android even when the device decodes them, forcing needless
    // H.264 transcodes. When the native video-capability plugin answered, trust
    // it for video codecs, their conditions, and the containers it can demux
    // (incl. mkv on ExoPlayer). Smart TVs (Tizen AVPlay / webOS) run as web
    // apps with no plugin: declare HEVC for them too, since their WebView MSE
    // probe can miss it while the panel hardware-decodes it.
    if (this.nativeVideo && this.nativeVideo.videoCodecs.length) {
      const nv = this.nativeVideo;
      videoCodecs.length = 0;
      codecConditions.length = 0;
      containers.length = 0;
      containers.push(...nv.containers);
      for (const c of nv.videoCodecs) {
        if (c === 'h264') {
          videoCodecs.push('h264', 'avc1');
          codecConditions.push({
            codec: 'h264',
            profiles: ['baseline', 'constrained baseline', 'main', 'high'],
            maxBitDepth: 8,
            ...this.nativeResCondition(nv, 'h264'),
          });
        } else if (c === 'hevc') {
          videoCodecs.push('hevc', 'h265', 'hvc1', 'hev1');
          codecConditions.push({
            codec: 'hevc',
            profiles: nv.hevcMain10 ? ['main', 'main 10'] : ['main'],
            maxBitDepth: nv.hevcMain10 ? 10 : 8,
            ...this.nativeResCondition(nv, 'hevc'),
          });
        } else if (c === 'av1') {
          videoCodecs.push('av1');
          codecConditions.push({
            codec: 'av1',
            profiles: nv.av1Main10 ? ['main', 'high'] : ['main'],
            maxBitDepth: nv.av1Main10 ? 10 : 8,
            ...this.nativeResCondition(nv, 'av1'),
          });
        } else {
          videoCodecs.push(c); // vp9 / vp8 — no fine-grained conditions
        }
      }
    } else if (
      (tvPlatform === 'tizen' || tvPlatform === 'webos') &&
      !videoCodecs.includes('hevc')
    ) {
      videoCodecs.push('hevc', 'h265', 'hvc1', 'hev1');
      codecConditions.push({
        codec: 'hevc',
        profiles: ['main', 'main 10'],
        maxBitDepth: 10,
      });
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
      // MP3 probed wrapped in MP4 (mp4a.6B/mp4a.69), the form we deliver —
      // Chrome's MSE rejects it though 'audio/mpeg' passes. webOS plays it
      // through its native <video>.
      if (
        this.testCodec(video, hasMSE, 'audio/mp4', 'mp4a.6B') ||
        this.testCodec(video, hasMSE, 'audio/mp4', 'mp4a.69') ||
        tvPlatform === 'webos'
      ) {
        audioCodecs.push('mp3');
      }
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
    // The native plugin reports the real DECODE capability (Android: per-codec
    // getMaxInputChannelCount; iOS: device-class estimate) — the device decodes
    // this many channels and the OS downmixes to the actual output, so a 5.1/
    // 7.1 source DirectPlays instead of a server-side downmix. (Web keeps the
    // AudioContext output-sink value above; browsers don't downmix multichannel
    // for us.)
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

    // Desktop native shell (Electron + embedded mpv): mpv/ffmpeg decode
    // virtually any codec/container, but the Chromium MSE probe wildly
    // under-reports (no HEVC, no E-AC3), which would force the backend to
    // transcode everything. Advertise mpv's broad capability set so sources
    // Direct Play / copy straight through.
    if (this.device.isDesktopNative()) {
      containers.length = 0;
      containers.push('mp4', 'mkv', 'webm', 'mov', 'ts', 'm4v', 'avi', 'flv');
      videoCodecs.length = 0;
      videoCodecs.push(
        'h264', 'avc1', 'hevc', 'h265', 'hvc1', 'hev1',
        'av1', 'vp9', 'vp8', 'mpeg2video', 'mpeg4',
      );
      codecConditions.length = 0;
      codecConditions.push(
        { codec: 'h264', profiles: ['baseline', 'constrained baseline', 'main', 'high'], maxBitDepth: 8 },
        { codec: 'hevc', profiles: ['main', 'main 10'], maxBitDepth: 10 },
        { codec: 'av1', profiles: ['main', 'high'], maxBitDepth: 10 },
      );
      audioCodecs = ['aac', 'ac3', 'eac3', 'opus', 'flac', 'alac', 'mp3', 'dts', 'truehd', 'vorbis'];
      maxAudioChannels = Math.max(maxAudioChannels, 8);
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
      audioChannelsByCodec: this.nativeAudio?.channelsByCodec,
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
      useTsOnSingleAudio: traits.useTsOnSingleAudio,
      // Players that decode the master SUBTITLES renditions natively (iOS
      // AVPlayer, Android ExoPlayer — phone and TV alike, web Shaka) render
      // cues inside the player pipeline. Only Tizen and webOS opt out: their
      // AVPlay/webOS cue APIs are limited, so those engines drive a DOM
      // overlay fed by sidecar VTT instead of the HLS renditions.
      supportsHlsSubtitles: traits.supportsHlsSubtitles,
      supportsImageSubtitles: traits.supportsImageSubtitles,
      // Only the web/Shaka path probes seg-0 on a load-then-seek; that is
      // exactly the `!isNative` engine branch (Capacitor mobile + every TV go
      // through native players that seek straight to the resume segment). The
      // Cast receiver sets this true in its own profile.
      probesSegZero: traits.probesSegZero,
      // Samsung Tizen AVPlay is HLS-only and cannot open a raw progressive
      // file, so it must never receive a DirectPlay decision — the backend
      // falls back to DirectStream (remux to HLS, codec-copy). Every other
      // engine (Shaka, ExoPlayer/AVPlayer, webOS <video>) plays raw files.
      supportsDirectPlay: traits.supportsDirectPlay,
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

  /** Turn the native plugin's per-codec decode ceiling into a codec-condition
   *  fragment. Empty when the plugin didn't report a resolution for this codec,
   *  leaving it unconstrained (the backend then Direct Plays any resolution). */
  private nativeResCondition(
    nv: NativeVideoCaps,
    key: string,
  ): { maxWidth?: number; maxHeight?: number } {
    const r = nv.resolutions?.[key];
    return r && r.width > 0 && r.height > 0
      ? { maxWidth: r.width, maxHeight: r.height }
      : {};
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
