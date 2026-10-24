import { detectBrowser, detectOs } from '../utils/ua-parser';
import { Injectable, inject } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PlayerSettingsService } from './player-settings.service';
import { DeviceService } from './device.service';
import { ServerConfigService } from './server-config.service';
import { AuthService } from './auth.service';
import { ENGINE_TRAITS, engineKindFor, type EngineTraits } from './engine-traits';
import { SystemInfoService } from './system-info.service';
import { applyTizenAudioCodecs, tizenSupportsHevc } from './tizen-capabilities';
import { isTizenCropSupported } from './playback-engine/tizen-engine';
import { getDeviceName } from '../utils/device-info';
import { environment } from '../../../environments/environment';
import { desktopBridgeOrNull } from '../plugins/desktop-player.bridge';

interface HdrPlugin {
  isSupported(): Promise<{
    supported: boolean;
    dolbyVision?: boolean;
    /** iOS only: the DV profiles this device is eligible to decode AND
     *  present, already resolved natively (see HdrPlugin.swift). */
    dolbyVisionProfiles?: number[];
  }>;
}
const Hdr = registerPlugin<HdrPlugin>('Hdr');

interface AudioCapabilitiesPlugin {
  getSupported(): Promise<{
    codecs: string[];
    maxChannels: number;
    /** Per-codec max decodable channel count (lowercased codec → channels). */
    channelsByCodec?: Record<string, number>;
  }>;
}
const AudioCaps = registerPlugin<AudioCapabilitiesPlugin>('AudioCapabilities');

interface NativeVideoCaps {
  videoCodecs: string[];
  hevcMain10: boolean;
  av1Main10: boolean;
  containers: string[];
  /** Per-codec max decodable resolution from MediaCodec VideoCapabilities; absent = unconstrained. */
  resolutions?: Record<string, { width: number; height: number }>;
  /** Android only: DV profiles the device's decoders report (not yet
   *  intersected with the display; see `VideoCapabilitiesPlugin.java`). */
  dolbyVisionProfiles?: number[];
  /** The NativePlayer plugin implements `setCrop`; absent on builds without it. */
  cropsBlackBars?: boolean;
}
interface VideoCapabilitiesPlugin {
  getSupported(): Promise<NativeVideoCaps>;
}
const VideoCaps = registerPlugin<VideoCapabilitiesPlugin>('VideoCapabilities');

/** Tizen panel-level HDR flag; more reliable than matchMedia on Chromium 85. False off Tizen or on throw. */
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

/** Builds a DeviceProfile by probing browser capabilities via canPlayType() and MediaSource.isTypeSupported(). */

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
  /** mpv tone-maps HDR to this SDR display itself, so the backend copies the
   *  HDR bitstream instead of re-encoding it. Desktop shell only. */
  tonemapsHdrLocally?: boolean;
  /** Client crops the detected black bars itself (mpv `video-crop` on
   *  desktop, a CSS transform for web/Shaka). False for native/TV. */
  cropsBlackBarsLocally?: boolean;
  /** Client can present single-layer Dolby Vision (P5 / 8.x) directly, so DirectPlay skips tonemapping.
   *  Absent = false on the backend. */
  supportsDolbyVision?: boolean;
  /** DV profiles this device can decode AND present, e.g. `[5, 8]`. Sent only
   *  when the server advertises `deviceProfileExtensions` and non-empty. */
  dolbyVisionProfiles?: number[];
  /** Client device category — selects the backend bitrate ladder.
   *  Capacitor native (iOS/Android app) → 'mobile'; web (incl. Cast sender) → 'desktop'. */
  deviceType: 'mobile' | 'desktop';
  /** Human-readable device shown on the admin streams dashboard
   *  ("Chrome — macOS", "iPhone"). Cosmetic only. */
  deviceName?: string;
  /** Real host OS name+version ("macOS 26", "iOS 18.5") resolved natively; the
   *  admin label prefers this over the UA-derived OS (which the UA freezes). */
  systemName?: string;
  /** Fliks client build version, sent only by non-web clients (a browser always runs the server's build). */
  appVersion?: string;
  /** Hard force MPEG-TS HLS for every transcode session; opt-in via `localStorage['fliks.useTs'] = '1'`. */
  useTs?: boolean;

  /** Force MPEG-TS only when the source has at most one audio track (Tizen AVPlay stalls on single-audio fMP4). */
  useTsOnSingleAudio?: boolean;

  /** Client renders HLS `SUBTITLES` renditions natively; when false the backend omits them and the client
   *  renders a sidecar VTT itself (TVs). */
  supportsHlsSubtitles?: boolean;

  /** Engine surfaces one audio track per language (webOS), so the backend publishes one rendition per language. */
  dedupesAudioByLanguage?: boolean;

  /** Engine names a single muxed audio track from a URI-less `EXT-X-MEDIA` (AVKit). */
  supportsMuxedAudioRendition?: boolean;

  /** Engine accelerates HLS from an `EXT-X-I-FRAME-STREAM-INF` rendition. */
  supportsIFrameTrickPlay?: boolean;

  /** Engine renders bitmap (PGS/VOBSUB) subtitles itself, only from a DirectPlay container; otherwise burned in. */
  supportsImageSubtitles?: boolean;

  /** Engine fetches seg-0 when loading the playlist, then seeks (web/Shaka, Cast receiver); native engines send
   *  false so the backend skips the seg-0 early-start companion. */
  probesSegZero?: boolean;

  /** Client can play a raw progressive file; false makes the backend fall back to DirectStream. Unset = true. */
  supportsDirectPlay?: boolean;

  /** Client engine switches audio tracks inside a raw DirectPlay file.
   *  `false` sends a picked non-first track through HLS. Unset = true. */
  switchesDirectPlayAudio?: boolean;

  /** Client can switch HLS variants at runtime; false collapses the master to a single variant. Unset = true. */
  supportsAbr?: boolean;

  /** One-shot per-request override (never part of the cached profile): asks
   *  the backend to transcode instead of a DirectStream copy it can't decode. */
  rejectCopy?: boolean;

  /** One-shot per-request override (not cached): text subtitle on an engine that can't sideload it into a raw file. */
  needsHlsSubtitles?: boolean;
}

/** Containers AVPlay demuxes (Samsung media spec). Over-declaring is safe: Direct Play also needs the codecs to match. */
const TIZEN_CONTAINERS = ['mp4', 'mkv', 'mov', 'ts', 'm2ts', 'avi', 'webm'];

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
  private readonly auth = inject(AuthService);
  private cachedProfile: DeviceProfile | null = null;
  private nativeHdr: boolean | null = null;
  private nativeDolbyVision: boolean | null = null;
  /** iOS reports the resolved profile list directly; Android leaves this
   *  null and the list comes from `nativeVideo.dolbyVisionProfiles` instead. */
  private nativeDvProfiles: number[] | null = null;
  private nativeAudio: {
    codecs: string[];
    maxChannels: number;
    channelsByCodec?: Record<string, number>;
  } | null = null;
  private nativeVideo: NativeVideoCaps | null = null;
  /** Pessimistic until the desktop probe resolves: P7 only, never 5/8 a bridge can't reshape. */
  private desktopCanReshapeDolbyVision = false;
  private desktopProbe: Promise<void> | null = null;

  /** Behavioural traits of the engine this device plays with. */
  engineTraits(): EngineTraits {
    return ENGINE_TRAITS[
      engineKindFor(
        this.device.tvPlatform(),
        this.serverConfig.isNative,
        this.device.isDesktopNative(),
        this.device.isIosNative(),
      )
    ];
  }

  /** Native (Capacitor) player whose plugin build implements `setCrop`. */
  nativeCropsBlackBars(): boolean {
    return Capacitor.isNativePlatform() && this.nativeVideo?.cropsBlackBars === true;
  }

  constructor() {
    // Pre-fetch native HDR + audio + video capabilities (async, cached for
    // later sync use)
    if (Capacitor.isNativePlatform()) {
      Hdr.isSupported()
        .then((r) => {
          this.nativeHdr = r.supported;
          this.nativeDolbyVision = r.dolbyVision ?? false;
          this.nativeDvProfiles = r.dolbyVisionProfiles ?? null;
          this.cachedProfile = null;
        })
        .catch(() => { this.nativeHdr = false; this.nativeDolbyVision = false; });
      AudioCaps.getSupported()
        .then((r) => { this.nativeAudio = r; this.cachedProfile = null; })
        .catch(() => { this.nativeAudio = null; });
      VideoCaps.getSupported()
        .then((r) => { this.nativeVideo = r; this.cachedProfile = null; })
        .catch(() => { this.nativeVideo = null; });
    }
    // Windows mpv can fall back off gpu-next at startup (old driver); the flag
    // is only read on Windows, the one desktop backend that can reshape DV.
    this.desktopProbe = desktopBridgeOrNull()
      ?.getPlayerCapabilities()
      .then((r) => {
        this.desktopCanReshapeDolbyVision = r.canReshapeDolbyVision;
        this.cachedProfile = null;
      })
      .catch((e) => console.warn('[DeviceProfile] desktop capability probe failed', e))
      .finally(() => { this.desktopProbe = null; }) ?? null;
  }

  /** Resolves once the desktop capability probe settles (or after `timeoutMs`), so a
   *  play right after launch doesn't negotiate with the pessimistic default. */
  whenDesktopProbed(timeoutMs = 4000): Promise<void> {
    if (!this.desktopProbe) return Promise.resolve();
    return Promise.race([this.desktopProbe, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  /** Build the device profile. Cached after first call. */
  getProfile(): DeviceProfile {
    if (!this.cachedProfile) {
      this.cachedProfile = this.buildProfile();
    }
    // Mutable overrides (HDR setting, `fliks.useTs`) are re-read on every call.
    const useTsOverride = readUseTsOverride();
    const forceDisableHdr = this.playerSettings.get().forceDisableHdr;
    const needsOverride =
      forceDisableHdr || useTsOverride !== !!this.cachedProfile.useTs;
    // systemName resolves asynchronously, so overlay it on every call instead of caching it.
    const systemName = this.systemInfo.systemName() || undefined;
    // An unadvertised server 400s on an unknown field; an empty list is
    // redundant with the boolean fallback. Omit it in both cases.
    const dolbyVisionProfiles =
      this.auth.hasServerFeature('deviceProfileExtensions') &&
      this.cachedProfile.dolbyVisionProfiles?.length
        ? this.cachedProfile.dolbyVisionProfiles
        : undefined;
    const supportsMuxedAudioRendition = this.auth.hasServerFeature('muxedAudioRendition')
      ? this.cachedProfile.supportsMuxedAudioRendition
      : undefined;
    if (!needsOverride) {
      return { ...this.cachedProfile, systemName, dolbyVisionProfiles, supportsMuxedAudioRendition };
    }
    return {
      ...this.cachedProfile,
      systemName,
      supportsMuxedAudioRendition,
      supportsHdr: forceDisableHdr ? false : this.cachedProfile.supportsHdr,
      // Forcing HDR off (user wants SDR) also drops DV passthrough — DV is HDR.
      supportsDolbyVision: forceDisableHdr
        ? false
        : this.cachedProfile.supportsDolbyVision,
      dolbyVisionProfiles: forceDisableHdr ? undefined : dolbyVisionProfiles,
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
    // Probed WITH a representative codec: a bare container mime is ambiguous and Chromium answers false.
    const containers: string[] = [];
    if (this.testCodec(video, hasMSE, 'video/mp4', 'avc1.42E01E')) {
      containers.push('mp4', 'm4v', 'mov');
    }
    if (this.testCodec(video, hasMSE, 'video/webm', 'vp8')) containers.push('webm');
    // MKV: no browser demuxes Matroska, so it stays out of the probed list. A
    // supported codec inside MKV still remuxes to HLS via DirectStream.

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

    // HEVC on Smart TV: AVPlay decodes it natively in HW.
    const isTv = this.device.isTv();
    const tvPlatform = this.device.tvPlatform();
    // Engine-behavioural flags come from one declarative row in `engine-traits.ts`.
    const traits = this.engineTraits();
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

    // AV1 off on TV: AVPlay's HLS demuxer accepts it inconsistently across firmware.
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

    // Native engines decode via the OS stack, whose capabilities beat the WebView's MSE probe: trust the plugin.
    // Smart TVs have no plugin: declare HEVC for them, their WebView probe can miss it.
    if (this.nativeVideo && this.nativeVideo.videoCodecs.length) {
      const nv = this.nativeVideo;
      // AVPlayer decodes what the WebView's WebKit probes, so its level ceiling
      // is kept; on Android the WebView under-reports and the plugin owns it.
      const probedLevels = new Map<string, number | undefined>(
        Capacitor.getPlatform() === 'ios' ? codecConditions.map((c) => [c.codec, c.maxLevel]) : [],
      );
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
            ...this.levelCondition(probedLevels, 'h264'),
            ...this.nativeResCondition(nv, 'h264'),
          });
        } else if (c === 'hevc') {
          videoCodecs.push('hevc', 'h265', 'hvc1', 'hev1');
          codecConditions.push({
            codec: 'hevc',
            profiles: nv.hevcMain10 ? ['main', 'main 10'] : ['main'],
            maxBitDepth: nv.hevcMain10 ? 10 : 8,
            ...this.levelCondition(probedLevels, 'hevc'),
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
      !videoCodecs.includes('hevc') &&
      (tvPlatform !== 'tizen' || tizenSupportsHevc() !== false)
    ) {
      videoCodecs.push('hevc', 'h265', 'hvc1', 'hev1');
      codecConditions.push({
        codec: 'hevc',
        profiles: ['main', 'main 10'],
        maxBitDepth: 10,
      });
    }

    // Tizen: use Samsung's published demuxer containers; the WebView probe answers for a pipeline that never plays.
    if (tvPlatform === 'tizen') {
      for (const c of TIZEN_CONTAINERS) {
        if (!containers.includes(c)) containers.push(c);
      }
    }

    // --- Detect supported audio codecs ---
    // On native the platform plugin is the source of truth; WebView canPlayType is unreliable (false ec-3 positives).
    let audioCodecs: string[];
    if (this.nativeAudio) {
      audioCodecs = [...this.nativeAudio.codecs];
    } else {
      audioCodecs = [];
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'mp4a.40.2')) audioCodecs.push('aac');
      // MP3 probed wrapped in MP4 (mp4a.6B/mp4a.69), the form we deliver; Chrome's MSE rejects it though 'audio/mpeg' passes.
      if (
        this.testCodec(video, hasMSE, 'audio/mp4', 'mp4a.6B') ||
        this.testCodec(video, hasMSE, 'audio/mp4', 'mp4a.69') ||
        tvPlatform === 'webos'
      ) {
        audioCodecs.push('mp3');
      }
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'ac-3')) audioCodecs.push('ac3');
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'ec-3')) audioCodecs.push('eac3');
      // Probed in fMP4 only, the form the HLS paths deliver them in.
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'opus')) audioCodecs.push('opus');
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'flac')) audioCodecs.push('flac');
      if (this.testCodec(video, hasMSE, 'audio/mp4', 'alac')) audioCodecs.push('alac');
      // AVPlay decodes the stream on Tizen, so its own capability API overrides
      // the MSE probe for every codec that API enumerates.
      if (tvPlatform === 'tizen') audioCodecs = applyTizenAudioCodecs(audioCodecs);
    }

    // --- Max audio channels ---
    let maxAudioChannels = 2;
    try {
      const ctx = new AudioContext();
      maxAudioChannels = ctx.destination.maxChannelCount || 2;
      ctx.close();
    } catch { /* fallback to stereo */ }
    // The plugin reports real DECODE channels; the OS downmixes to the output, so 5.1/7.1 sources DirectPlay.
    if (this.nativeAudio) {
      maxAudioChannels = Math.max(maxAudioChannels, this.nativeAudio.maxChannels);
    }
    // A browser decodes 7.1 AAC, Opus and FLAC and downmixes them to its output
    // itself, so their cap is the decoder's, not AudioContext's output count.
    const audioChannelsByCodec =
      this.nativeAudio?.channelsByCodec ??
      (tvPlatform ? undefined : { aac: 8, opus: 8, flac: 8 });
    // TVs: the WebView's AudioContext caps at 2ch but the pipeline decodes Dolby, so declare 5.1 for AC3/EAC3.
    if (
      (tvPlatform === 'webos' || tvPlatform === 'tizen') &&
      (audioCodecs.includes('eac3') || audioCodecs.includes('ac3'))
    ) {
      maxAudioChannels = Math.max(maxAudioChannels, 6);
    }

    // Desktop shell: mpv decodes virtually any codec but the Chromium MSE probe under-reports, so advertise mpv's set.
    if (this.device.isDesktopNative()) {
      containers.length = 0;
      containers.push('mp4', 'mkv', 'webm', 'mov', 'ts', 'm4v', 'avi', 'flv', 'm2ts', 'mts', 'mpg', 'mpeg', 'wmv', 'ogm');
      videoCodecs.length = 0;
      videoCodecs.push(
        'h264', 'avc1', 'hevc', 'h265', 'hvc1', 'hev1',
        'av1', 'vp9', 'vp8', 'mpeg1video', 'mpeg2video', 'mpeg4', 'msmpeg4v3', 'vc1', 'wmv3', 'theora',
      );
      codecConditions.length = 0;
      codecConditions.push(
        {
          codec: 'h264',
          profiles: ['baseline', 'constrained baseline', 'main', 'high', 'high 10', 'high 10 intra', 'high 4:2:2'],
          maxBitDepth: 10,
        },
        { codec: 'hevc', profiles: ['main', 'main 10'], maxBitDepth: 10 },
        { codec: 'av1', profiles: ['main', 'high'], maxBitDepth: 10 },
      );
      audioCodecs = ['aac', 'ac3', 'eac3', 'opus', 'flac', 'alac', 'mp3', 'dts', 'truehd', 'vorbis', 'mp2', 'pcm_s16le', 'pcm_s24le', 'pcm_bluray'];
      maxAudioChannels = Math.max(maxAudioChannels, 8);
    }

    // --- HDR support ---
    let supportsHdr: boolean;
    if (Capacitor.isNativePlatform()) {
      // Use native plugin result (pre-fetched in constructor). Default true if not yet resolved.
      supportsHdr = this.nativeHdr ?? true;
    } else if (isTizenHdrCapable()) {
      // Tizen: use `isHdrTvSupport()` (matchMedia is unreliable on Chromium 85), combined with a 10-bit codec check.
      const has10bitCodec = codecConditions.some(c => (c.maxBitDepth ?? 0) >= 10);
      supportsHdr = has10bitCodec;
    } else {
      const hdrDisplay = typeof matchMedia !== 'undefined' && matchMedia('(dynamic-range: high)').matches;
      const has10bitCodec = codecConditions.some(c => (c.maxBitDepth ?? 0) >= 10);
      supportsHdr = hdrDisplay && has10bitCodec;
    }

    // mpv tone-maps HDR to an SDR display itself, so the server can copy the bitstream.
    const tonemapsHdrLocally = this.device.isDesktopNative() && !supportsHdr;
    // A plain browser always runs the server's current build, so only the
    // installed clients report a build version worth surfacing.
    const isWeb =
      !Capacitor.isNativePlatform() && !isTv && !this.device.isDesktopNative();
    // `video-crop` cuts bars at the VO (hwdec-safe) on every mpv backend; web crops in CSS, see `WebVideoCropController`.
    const cropsBlackBarsLocally =
      this.device.isDesktopNative() || isWeb || this.nativeCropsBlackBars() || isTizenCropSupported();

    // DV profiles the device can decode AND present, gated under supportsHdr; Samsung TVs have no Dolby Vision.
    const dolbyVisionProfiles: number[] = !supportsHdr || tvPlatform === 'tizen'
      ? []
      : Capacitor.isNativePlatform()
        ? this.nativeDolbyVision
          ? (this.nativeDvProfiles ?? this.nativeVideo?.dolbyVisionProfiles ?? [5, 8])
          : []
        : this.probeDolbyVisionProfiles(video, hasMSE);
    // mpv decodes dual-layer P7 and tone-maps it locally, so list it regardless of supportsHdr.
    if (this.device.isDesktopNative() && !dolbyVisionProfiles.includes(7)) {
      dolbyVisionProfiles.push(7);
    }
    // Windows mpv (gpu-next) reshapes P5/P7/P8 via libplacebo; a failed
    // gpu-next init (old driver) falls back to a P7-only base layer.
    if (this.device.isDesktopNative() && detectOs(navigator.userAgent) === 'Windows') {
      dolbyVisionProfiles.length = 0;
      dolbyVisionProfiles.push(...(this.desktopCanReshapeDolbyVision ? [5, 7, 8] : [7]));
    }
    // A [10]-only list must not read as P5/P8-capable to an old server that
    // only understands this boolean.
    const supportsDolbyVision =
      dolbyVisionProfiles.includes(5) || dolbyVisionProfiles.includes(8);

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
      audioChannelsByCodec,
      supportsHdr,
      tonemapsHdrLocally,
      cropsBlackBarsLocally,
      supportsDolbyVision,
      dolbyVisionProfiles,
      deviceType: Capacitor.isNativePlatform() ? 'mobile' : 'desktop',
      deviceName: getDeviceName(),
      appVersion: isWeb ? undefined : environment.version,
      useTs,
      // Tizen alone needs MPEG-TS on single-audio sources (issue #148).
      useTsOnSingleAudio: traits.useTsOnSingleAudio,
      // Only Tizen and webOS opt out of native SUBTITLES renditions: their cue APIs are limited, so they use a DOM overlay.
      supportsHlsSubtitles: traits.supportsHlsSubtitles,
      dedupesAudioByLanguage: traits.dedupesAudioByLanguage,
      supportsMuxedAudioRendition: traits.supportsMuxedAudioRendition,
      supportsIFrameTrickPlay: traits.supportsIFrameTrickPlay,
      supportsImageSubtitles: traits.supportsImageSubtitles,
      // Only the web/Shaka path probes seg-0 on load-then-seek; the Cast receiver sets this true in its own profile.
      probesSegZero: traits.probesSegZero,
      // Every shipping engine opens a raw progressive file (Tizen AVPlay demuxes MKV itself).
      supportsDirectPlay: traits.supportsDirectPlay,
      // Only web probes it (every other engine switches natively); skip Firefox,
      // whose `audioTracks` toggle doesn't switch what plays.
      switchesDirectPlayAudio: isWeb
        ? 'audioTracks' in HTMLMediaElement.prototype && detectBrowser(navigator.userAgent) !== 'Firefox'
        : undefined,
      // False only for the desktop mpv engine (see engine-traits.ts).
      supportsAbr: traits.supportsAbr,
    };
  }

  // --- Probing helpers ---

  /** Codec gate for the backend profile: browser playback runs through MSE, so require isTypeSupported
   *  (canPlayType's "maybe" can pass codecs MSE rejects, e.g. HEVC on Chrome Linux). */
  private testCodec(video: HTMLVideoElement, hasMSE: boolean, mime: string, codec: string): boolean {
    const full = codec ? `${mime}; codecs="${codec}"` : mime;
    if (hasMSE) return MediaSource.isTypeSupported(full);
    return !!video.canPlayType(full);
  }

  /** Probe single-layer Dolby Vision decode per profile (5, 8, 10), included
   *  only if the pipeline actually claims that codec string. */
  private probeDolbyVisionProfiles(video: HTMLVideoElement, hasMSE: boolean): number[] {
    const profiles: number[] = [];
    if (
      this.testCodec(video, hasMSE, 'video/mp4', 'dvh1.05.06') ||
      this.testCodec(video, hasMSE, 'video/mp4', 'dvhe.05.06')
    ) profiles.push(5);
    if (
      this.testCodec(video, hasMSE, 'video/mp4', 'dvh1.08.06') ||
      this.testCodec(video, hasMSE, 'video/mp4', 'dvhe.08.06')
    ) profiles.push(8);
    if (this.testCodec(video, hasMSE, 'video/mp4', 'dav1.10.06')) profiles.push(10);
    return profiles;
  }

  /** Turn the plugin's per-codec decode ceiling into a codec-condition fragment; empty when unreported. */
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
  private levelCondition(levels: Map<string, number | undefined>, codec: string): { maxLevel?: number } {
    const maxLevel = levels.get(codec);
    return maxLevel === undefined ? {} : { maxLevel };
  }

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
