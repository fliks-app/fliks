import { detectBrowser, detectOs } from '../utils/ua-parser';
import { Injectable, inject } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PlayerSettingsService } from './player-settings.service';
import { DeviceService } from './device.service';
import { ServerConfigService } from './server-config.service';
import { AuthService } from './auth.service';
import { ENGINE_TRAITS, engineKindFor, type EngineTraits } from './engine-traits';
import { SystemInfoService } from './system-info.service';
import { applyTizenAudioCodecs, tizenVideo } from './tizen-capabilities';
import { webosAudioCodecs, webosDevice, webosMkvProfile, webosVideo, type WebOsDevice } from './webos-capabilities';
import { detectDolbyVisionProfiles, detectSampleEntries, detectWebVideo, webVideoMimes, type TypeProbe } from './device-capabilities/web-video';
import { detectHdrTransfers, undecodableVideoMimes, type HdrTransfers } from './device-capabilities/media-capabilities';
import { mpvAudioCodecs, mpvVideo } from './device-capabilities/desktop-mpv';
import { isTizenCropSupported } from './playback-engine/tizen-engine';
import { getDeviceName, getOrCreateDeviceId } from '../utils/device-info';
import { environment } from '../../../environments/environment';
import { desktopBridgeOrNull } from '../plugins/desktop-player.bridge';
import { probeAudioDirectPlay, undecodableAudioFormats } from './audio-direct-play';

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
    /** Bitstreams the HDMI sink takes untouched; absent on older builds. */
    passthrough?: { codecs: string[]; maxChannels: number };
    /** The audio files the native player opens as they are, from the platform's own decoders. */
    audioFiles?: DirectPlayProfile;
  }>;
  addListener(event: 'audioRouteChanged', cb: () => void): Promise<unknown>;
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
  /** Stable per-installation id; the server keys the device's codec support on it. */
  deviceId?: string;
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
    passthrough?: { codecs: string[]; maxChannels: number };
    audioFiles?: DirectPlayProfile;
  } | null = null;
  private nativeVideo: NativeVideoCaps | null = null;
  /** Pessimistic until the desktop probe resolves: P7 only, never 5/8 a bridge can't reshape. */
  private desktopCanReshapeDolbyVision = false;
  private desktopProbe: Promise<void> | null = null;
  /** Settles once the native plugins answered; a profile built before holds none of what they detect. */
  private nativeProbe: Promise<void> = Promise.resolve();
  private audioProbe: HTMLAudioElement | null = null;
  private undecodableAudio: ReadonlySet<string> = new Set();
  /** Video MIMEs `mediaCapabilities` refuses, and the HDR transfers it decodes; filled once resolved. */
  private undecodableVideo: ReadonlySet<string> = new Set();
  private hdrTransfers: HdrTransfers | null = null;
  /** mpv's own decoder and demuxer lists; null until the desktop probe answers. */
  private mpv: { decoders: string[]; demuxers: string[] } | null = null;
  private readonly webos: WebOsDevice | null = this.device.tvPlatform() === 'webos' ? webosDevice() : null;

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

  private deviceId: string | undefined;

  constructor() {
    getOrCreateDeviceId().then((id) => (this.deviceId = id)).catch(() => {});
    // Pre-fetch native HDR + audio + video capabilities (async, cached for
    // later sync use)
    if (Capacitor.isNativePlatform()) {
      const loadAudio = () => AudioCaps.getSupported()
        .then((r) => { this.nativeAudio = r; this.cachedProfile = null; })
        .catch(() => { this.nativeAudio = null; });
      this.nativeProbe = Promise.all([
        Hdr.isSupported()
          .then((r) => {
            this.nativeHdr = r.supported;
            this.nativeDolbyVision = r.dolbyVision ?? false;
            this.nativeDvProfiles = r.dolbyVisionProfiles ?? null;
            this.cachedProfile = null;
          })
          .catch(() => { this.nativeHdr = false; this.nativeDolbyVision = false; }),
        loadAudio(),
        VideoCaps.getSupported()
          .then((r) => { this.nativeVideo = r; this.cachedProfile = null; })
          .catch(() => { this.nativeVideo = null; }),
      ]).then(() => undefined);
      // HDMI hot-plug: a receiver can come or go mid-session.
      void AudioCaps.addListener('audioRouteChanged', () => void loadAudio()).catch(() => undefined);
    }
    if (!Capacitor.isNativePlatform()) {
      void undecodableAudioFormats().then((denied) => this.refresh(() => (this.undecodableAudio = denied)));
    }
    void undecodableVideoMimes(webVideoMimes()).then((denied) => this.refresh(() => (this.undecodableVideo = denied)));
    void detectHdrTransfers().then((t) => this.refresh(() => (this.hdrTransfers = t)));
    // Windows mpv can fall back off gpu-next at startup (old driver); the flag
    // is only read on Windows, the one desktop backend that can reshape DV.
    this.desktopProbe = desktopBridgeOrNull()
      ?.getPlayerCapabilities()
      .then((r) => {
        this.desktopCanReshapeDolbyVision = r.canReshapeDolbyVision;
        if (r.decoders?.length) this.mpv = { decoders: r.decoders, demuxers: r.demuxers ?? [] };
        this.cachedProfile = null;
      })
      .catch((e) => console.warn('[DeviceProfile] desktop capability probe failed', e))
      .finally(() => { this.desktopProbe = null; }) ?? null;
  }

  /** Resolves once the native plugins' answers are in the profile. */
  whenNativeProbed(): Promise<void> {
    return this.nativeProbe;
  }

  /** Applies a late probe answer and drops the profile built without it. */
  private refresh(apply: () => void): void {
    apply();
    this.cachedProfile = null;
  }

  /** Resolves once the desktop capability probe settles (or after `timeoutMs`), so a
   *  play right after launch doesn't negotiate with the pessimistic default. */
  whenDesktopProbed(timeoutMs = 4000): Promise<void> {
    if (!this.desktopProbe) return Promise.resolve();
    return Promise.race([this.desktopProbe, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  /** Audio codecs the device direct-plays, lowercased: what a track must be in to be chosen over one that is not. */
  playableAudioCodecs(): string[] {
    const all = this.getProfile()
      .directPlayProfiles.filter((p) => p.videoCodecs.length)
      .flatMap((p) => p.audioCodecs.map((c) => c.toLowerCase()));
    return [...new Set(all)];
  }

  maxAudioChannels(): number {
    return this.getProfile().maxAudioChannels;
  }

  /** Whether this device's profile offers bitstream passthrough (Android TV with a capable sink). */
  offersPassthrough(): boolean {
    return this.device.tvPlatform() === 'androidtv' && !!this.nativeAudio?.passthrough?.codecs.length;
  }

  /** Build the device profile. Cached after first call. */
  getProfile(opts: { passthrough?: boolean } = {}): DeviceProfile {
    if (!this.cachedProfile) {
      this.cachedProfile = this.buildProfile();
    }
    // Uncached: only a playback whose bitstream could not be muted asks for it.
    const base = opts.passthrough === false ? this.buildProfile(false) : this.cachedProfile;
    // Mutable overrides (HDR setting, `fliks.useTs`) are re-read on every call.
    const useTsOverride = readUseTsOverride();
    const forceDisableHdr = this.playerSettings.get().forceDisableHdr;
    const needsOverride =
      forceDisableHdr || useTsOverride !== !!base.useTs;
    // systemName resolves asynchronously, so overlay it on every call instead of caching it.
    const systemName = this.systemInfo.systemName() || undefined;
    const deviceId = this.auth.hasServerFeature('deviceProfileExtensions') ? this.deviceId : undefined;
    // An unadvertised server 400s on an unknown field; an empty list is
    // redundant with the boolean fallback. Omit it in both cases.
    const dolbyVisionProfiles =
      this.auth.hasServerFeature('deviceProfileExtensions') &&
      base.dolbyVisionProfiles?.length
        ? base.dolbyVisionProfiles
        : undefined;
    const supportsMuxedAudioRendition = this.auth.hasServerFeature('muxedAudioRendition')
      ? base.supportsMuxedAudioRendition
      : undefined;
    if (!needsOverride) {
      return { ...base, systemName, deviceId, dolbyVisionProfiles, supportsMuxedAudioRendition };
    }
    return {
      ...base,
      systemName,
      deviceId,
      supportsMuxedAudioRendition,
      supportsHdr: forceDisableHdr ? false : base.supportsHdr,
      // Forcing HDR off (user wants SDR) also drops DV passthrough — DV is HDR.
      supportsDolbyVision: forceDisableHdr
        ? false
        : base.supportsDolbyVision,
      dolbyVisionProfiles: forceDisableHdr ? undefined : dolbyVisionProfiles,
      useTs: useTsOverride,
    };
  }

  /** Whether the display hardware supports HDR (ignoring user preference). */
  get hardwareSupportsHdr(): boolean {
    if (!this.cachedProfile) this.cachedProfile = this.buildProfile();
    return this.cachedProfile.supportsHdr;
  }

  private buildProfile(passthrough = true): DeviceProfile {
    const video = document.createElement('video');
    const supported = this.typeProbe(video);
    const plays: TypeProbe = (mime) => !!video.canPlayType(mime);

    // Containers, codecs and levels from the engine's own probe, then replaced by the platform's own answer where the WebView is not what decodes.
    let { containers, videoCodecs, codecConditions } = detectWebVideo(supported);

    const isTv = this.device.isTv();
    const tvPlatform = this.device.tvPlatform();
    // Engine-behavioural flags come from one declarative row in `engine-traits.ts`.
    const traits = this.engineTraits();

    // Native engines decode via the OS stack, whose capabilities beat the WebView's MSE probe: trust the plugin.
    if (this.nativeVideo && this.nativeVideo.videoCodecs.length) {
      const nv = this.nativeVideo;
      // AVPlayer decodes what the WebView's WebKit probes, so its level ceiling
      // is kept; on Android the WebView under-reports and the plugin owns it.
      const probedLevels = new Map<string, number | undefined>(
        Capacitor.getPlatform() === 'ios' ? codecConditions.map((c) => [c.codec, c.maxLevel]) : [],
      );
      videoCodecs = [];
      codecConditions = [];
      containers = [...nv.containers];
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
          videoCodecs.push('hevc', 'h265', 'hvc1');
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
          videoCodecs.push(c); // vp9 / vp8: no fine-grained conditions
        }
      }
    } else if (tvPlatform === 'tizen') {
      ({ containers, videoCodecs, codecConditions } = tizenVideo({ containers, videoCodecs, codecConditions }));
    } else if (tvPlatform === 'webos') {
      ({ containers, videoCodecs, codecConditions } = webosVideo({ containers, videoCodecs, codecConditions }));
    }

    // --- Detect supported audio codecs ---
    // On native the platform plugin is the source of truth; WebView canPlayType is unreliable (false ec-3 positives).
    let audioCodecs: string[];
    if (this.nativeAudio) {
      audioCodecs = [...this.nativeAudio.codecs];
    } else {
      audioCodecs = [];
      if (supported('audio/mp4; codecs="mp4a.40.2"')) audioCodecs.push('aac');
      // MP3 probed wrapped in MP4 (mp4a.6B/mp4a.69), the form we deliver; Chrome's MSE rejects it though 'audio/mpeg' passes.
      if (supported('audio/mp4; codecs="mp4a.6B"') || supported('audio/mp4; codecs="mp4a.69"')) {
        audioCodecs.push('mp3');
      }
      if (supported('audio/mp4; codecs="ac-3"')) audioCodecs.push('ac3');
      if (supported('audio/mp4; codecs="ec-3"')) audioCodecs.push('eac3');
      // Probed in fMP4 only, the form the HLS paths deliver them in.
      if (supported('audio/mp4; codecs="opus"')) audioCodecs.push('opus');
      if (supported('audio/mp4; codecs="flac"')) audioCodecs.push('flac');
      if (supported('audio/mp4; codecs="alac"')) audioCodecs.push('alac');
      // AVPlay decodes the stream on Tizen, so its own capability API overrides
      // the MSE probe for every codec that API enumerates.
      if (tvPlatform === 'tizen') audioCodecs = applyTizenAudioCodecs(audioCodecs);
      if (tvPlatform === 'webos') audioCodecs = webosAudioCodecs(audioCodecs);
    }

    // Android TV: bitstreams the HDMI sink takes reach the receiver untouched, decoder or not.
    const sink = passthrough && tvPlatform === 'androidtv' ? this.nativeAudio?.passthrough : undefined;
    if (sink) {
      for (const c of sink.codecs) {
        if (!audioCodecs.includes(c)) audioCodecs.push(c);
      }
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
    // No TV spec lists multichannel Opus or FLAC (Samsung: DD+ 5.1); AVPlay plays a 5.1 Opus copy silent.
    let audioChannelsByCodec =
      this.nativeAudio?.channelsByCodec ??
      (tvPlatform === 'tizen' || tvPlatform === 'webos'
        ? { opus: 2, flac: 2 }
        : tvPlatform ? undefined : { aac: 8, opus: 8, flac: 8 });
    if (sink?.codecs.length) {
      audioChannelsByCodec = { ...audioChannelsByCodec };
      for (const c of sink.codecs) {
        audioChannelsByCodec[c] = Math.max(audioChannelsByCodec[c] ?? 0, sink.maxChannels);
      }
      maxAudioChannels = Math.max(maxAudioChannels, sink.maxChannels);
    }
    // TVs: the WebView's AudioContext caps at 2ch but the pipeline decodes Dolby, so declare 5.1 for AC3/EAC3.
    if (
      (tvPlatform === 'webos' || tvPlatform === 'tizen') &&
      (audioCodecs.includes('eac3') || audioCodecs.includes('ac3'))
    ) {
      maxAudioChannels = Math.max(maxAudioChannels, 6);
    }

    // Desktop shell: mpv decodes what its own lists name, which the Chromium MSE probe under-reports.
    if (this.device.isDesktopNative() && this.mpv) {
      ({ containers, videoCodecs, codecConditions } = mpvVideo(this.mpv.decoders, this.mpv.demuxers));
      audioCodecs = mpvAudioCodecs(this.mpv.decoders);
      maxAudioChannels = Math.max(maxAudioChannels, 8);
    }

    // The file's own demuxer reads these, not MSE (Apple refuses `hev1`): WebKit, browsers and webOS answer
    // canPlayType; mpv, Media3 and AVPlay demux every MP4 sample entry themselves and have no probe.
    const demuxesEveryEntry =
      this.device.isDesktopNative() ||
      tvPlatform === 'tizen' ||
      (Capacitor.getPlatform() === 'android' && !!this.nativeVideo?.videoCodecs.length);
    videoCodecs.push(...detectSampleEntries(videoCodecs, plays, demuxesEveryEntry));

    // --- HDR support ---
    let supportsHdr: boolean;
    if (Capacitor.isNativePlatform()) {
      // The display's answer (pre-fetched in constructor, true until resolved), and a 10-bit decoder behind it.
      supportsHdr = (this.nativeHdr ?? true) && (!this.nativeVideo || codecConditions.some((c) => (c.maxBitDepth ?? 0) >= 10));
    } else if (isTizenHdrCapable()) {
      // Tizen: use `isHdrTvSupport()` (matchMedia is unreliable on Chromium 85), combined with a 10-bit codec check.
      const has10bitCodec = codecConditions.some(c => (c.maxBitDepth ?? 0) >= 10);
      supportsHdr = has10bitCodec;
    } else {
      // webOS reports its panel itself; elsewhere the media query, then the engine's PQ decode when `mediaCapabilities` answers.
      const hdrDisplay =
        this.webos?.hdr10 ?? (typeof matchMedia !== 'undefined' && matchMedia('(dynamic-range: high)').matches);
      const has10bitCodec = codecConditions.some(c => (c.maxBitDepth ?? 0) >= 10);
      supportsHdr = hdrDisplay && has10bitCodec && (this.hdrTransfers?.pq ?? true);
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
        : this.webos?.dolbyVision === false
          ? []
          : detectDolbyVisionProfiles(supported);
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
      directPlayProfiles: [
        { containers, videoCodecs, audioCodecs },
        ...(tvPlatform === 'webos' ? [webosMkvProfile(this.webos)] : []),
        ...this.audioFilesProfile(),
      ],
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

  /** The engine's answer for a MIME: browser playback runs through MSE, so require `isTypeSupported` (canPlayType's
   *  "maybe" can pass codecs MSE rejects, e.g. HEVC on Chrome Linux), minus what `mediaCapabilities` refuses. */
  private typeProbe(video: HTMLVideoElement): TypeProbe {
    const mse = typeof MediaSource !== 'undefined' && !!MediaSource.isTypeSupported;
    return (mime) =>
      !this.undecodableVideo.has(mime) && (mse ? MediaSource.isTypeSupported(mime) : !!video.canPlayType(mime));
  }

  /** The audio files the device opens as they are: the platform plugin on native builds, else what the page's own audio element reports. */
  private audioFilesProfile(): DirectPlayProfile[] {
    this.audioProbe ??= new Audio();
    const files = Capacitor.isNativePlatform()
      ? this.nativeAudio?.audioFiles
      : probeAudioDirectPlay(this.audioProbe, this.undecodableAudio);
    return files?.containers.length ? [files] : [];
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
}
