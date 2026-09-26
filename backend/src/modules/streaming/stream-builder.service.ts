import { Injectable, Logger } from '@nestjs/common';
import { DeviceProfileDto } from './dto/device-profile.dto';
import {
  AudioTrackPlan,
  PlaybackInfoResponse,
  PlayMethod,
  QualityOption,
  TranscodeReason,
} from './dto/playback-info.dto';
import { ResolvedFile } from './streaming.service';
import {
  DeviceType,
  TranscodeProfile,
  TranscodingService,
  getHdrLadderForDevice,
  getLadderForDevice,
  isEcoProfile,
  resolveLadderRung,
  parseBitrateToBps,
  profileFitsSource,
  resolveSourceVideoBitrateBps,
} from './transcoding';
import {
  cappedRungVideoBitrateBps,
  type RungBitrateContext,
} from './transcoding/quality-ladder';
import { resolveEncodePipeline } from './transcoding/encode-pipeline';
import { parseSourceFps } from './transcoding/constants';
import { ActiveStreamTracker } from './active-stream-tracker.service';
import {
  bucketResolutionHeight,
  resolutionFitsCap,
} from '../../common/utils/resolution.util';
import { normaliseSourceCodec } from './transcoding/codec/normalise';
import { deriveDvInfo, isDvProfile5 } from './transcoding/codec/dolby-vision';
import { pickPrimaryVariant } from './transcoding/codec/selector';
import type { CodecVariant, VideoCodec } from './transcoding/codec/types';
import { resolveMuxFlavour } from './transcoding/audio-layout';
import {
  audioEncodeBitrateBps,
  encoderMaxChannels,
  isEncodableAudio,
  type AudioEncodeCodec,
  type AudioPlan,
} from './transcoding/audio-encode';
import type { MediaFileInfo } from '../subtitles/ffprobe.service';
import { videoPresentationStart } from './transcoding/source-timeline';

/** Audio codecs that can be copied verbatim into fMP4 segments via MSE.
 *  Anything outside this set is re-encoded to AAC on the remux path even when
 *  the device profile claims support — Chrome rejects e.g. `audio/mp4;
 *  codecs="mp4a.6B"` (MP3) on append. */
const FMP4_COMPATIBLE_AUDIO = new Set(['aac', 'ac3', 'eac3', 'opus', 'flac']);

/** Above the start offset encoder priming alone reports (AAC ~23 ms, E-AC-3 ~5 ms, Opus ~7 ms). */
const AUDIO_START_OFFSET_THRESHOLD_SECONDS = 0.05;

/** Containers that carry AAC as ADTS, where every frame restates its
 *  configuration and broadcasts switch it (2.0 ↔ 5.1) mid-stream. */
const ADTS_AAC_CONTAINERS = new Set(['ts', 'm2ts']);

type CopyBlocker = 'AudioStartOffset' | 'AudioFormatMayChange';

/**
 * Why a track the device could play as-is must still be re-encoded on this
 * output, or null. Only fMP4 is affected: MPEG-TS carries both as they are.
 * - A start offset lands in an empty edit, which MSE ignores; the encode
 *   aligns the track instead.
 * - fMP4 holds one AAC configuration for the whole track, taken from the first
 *   frame, so a copied ADTS stream that switches layout stops decoding there.
 */
function copyBlocker(
  audio: { codec?: string; startTimeSeconds?: number },
  video: Parameters<typeof videoPresentationStart>[0],
  muxFlavour: 'ts' | 'fmp4',
  container: string,
): CopyBlocker | null {
  if (muxFlavour !== 'fmp4') return null;
  if (
    (audio.codec ?? '').toLowerCase() === 'aac' &&
    ADTS_AAC_CONTAINERS.has(container)
  ) {
    return 'AudioFormatMayChange';
  }
  const a = audio.startTimeSeconds;
  const v = videoPresentationStart(video);
  return a != null &&
    v != null &&
    Math.abs(a - v) > AUDIO_START_OFFSET_THRESHOLD_SECONDS
    ? 'AudioStartOffset'
    : null;
}

/** Transcode reason for each per-track flag. */
function audioReason(flag: string, t: AudioTrackPlan): TranscodeReason {
  const messages: Record<string, string> = {
    AudioChannelsNotSupported: `${t.channels} channels > max ${t.outputChannels}`,
    AudioCodecNotSupported: `Audio codec "${t.codec}" is not playable here`,
    AudioStartOffset:
      'Audio starts off the video and is re-encoded to align it',
    AudioFormatMayChange:
      'AAC from MPEG-TS can change format mid-stream and is re-encoded',
  };
  return { flag, message: messages[flag] ?? flag };
}

/** The single-track plan of one rendition's decision. */
function toAudioPlan(t: AudioTrackPlan, stereoBitrateBps: number): AudioPlan {
  if (t.copy) return { mode: 'copy', codec: t.outputCodec };
  const codec = t.outputCodec as AudioEncodeCodec;
  const channels = t.outputChannels ?? 2;
  return {
    mode: 'transcode',
    codec,
    channels,
    bitrateBps: audioEncodeBitrateBps(codec, channels, stereoBitrateBps),
  };
}

/** Max channels the device can decode for `codec` — the per-codec cap when the
 *  profile carries one (`audioChannelsByCodec`), else the global
 *  `maxAudioChannels`, else stereo. Lets a device decode AAC 7.1 while its
 *  EAC-3 decoder tops out at 5.1, instead of a single device-wide number. */
function audioChannelCap(profile: DeviceProfileDto, codec: string): number {
  return (
    profile.audioChannelsByCodec?.[codec.toLowerCase()] ??
    profile.maxAudioChannels ??
    2
  );
}

/**
 * What stream-builder hands back: the public playback-info response,
 * plus the two side-band decisions the controller threads onto the
 * LiveSession (no more tracker side-effects from this service).
 */
export interface EvaluateResult {
  response: PlaybackInfoResponse;
  useHdrLadder: boolean;
  videoVariant: CodecVariant | null;
}

/**
 * Decides how a media file should be played: DirectPlay, DirectStream (remux), or Transcode.
 *
 * Decision tree:
 * 1. If container + video codec + audio codec all match a DirectPlayProfile
 *    AND all codec conditions pass → DirectPlay
 * 2. If only container or audio fails (video is compatible) → DirectStream (remux)
 *    Video stream is copied, container is changed, audio may be transcoded
 * 3. Otherwise → full Transcode (video re-encoded via HLS)
 */
@Injectable()
export class StreamBuilderService {
  private readonly log = new Logger(StreamBuilderService.name);

  constructor(
    private readonly transcodingService: TranscodingService,
    private readonly activeStreamTracker: ActiveStreamTracker,
  ) {}

  /**
   * Evaluate a media file against a device profile and return the playback decision.
   */
  evaluate(
    resolved: ResolvedFile,
    profile: DeviceProfileDto,
    tokenParam: string,
    burnInSubtitleId?: number,
    requestedQuality?: string,
    autoQualityMode: 'directplay' | 'abr' = 'directplay',
    audioStreamIndex?: number,
  ): EvaluateResult {
    const si = resolved.mediaFile.streamInfo;
    const v = si?.video?.[0];
    const audioStreams = si?.audio ?? [];
    // The track the client asked for decides everything below; an index
    // outside the file falls back to the first track.
    const pickedAudio =
      audioStreamIndex != null &&
      audioStreamIndex >= 0 &&
      audioStreamIndex < audioStreams.length
        ? audioStreamIndex
        : 0;
    const a = audioStreams[pickedAudio];
    const formatBitRate =
      si?.formatBitRate != null && si.formatBitRate > 0
        ? si.formatBitRate
        : undefined;
    const audioSumBitrate = audioStreams.reduce(
      (sum, s) => sum + (s.bitRate ?? 0),
      0,
    );

    const videoBitRate = resolveSourceVideoBitrateBps(
      v?.bitRate,
      formatBitRate,
      audioSumBitrate,
    );

    let audioBitRate = a?.bitRate;
    if (audioBitRate == null && formatBitRate != null && videoBitRate != null) {
      const leftover = formatBitRate - videoBitRate;
      if (leftover > 1_000) audioBitRate = leftover;
    }

    const sourceContainer = resolved.ext.replace('.', '').toLowerCase();
    const sourceVideoCodec = (v?.codec ?? '').toLowerCase();
    const sourceAudioCodec = (a?.codec ?? '').toLowerCase();

    // Admin auto-crop toggle. Gates both the play-method decision (needsCrop)
    // and the crop surfaced in the response, so the stats overlay shows the
    // crop actually applied — not merely the one cropdetect found at import.
    const autoCropEnabled = this.activeStreamTracker.getAutoCropEnabled();

    const source = {
      container: sourceContainer,
      videoCodec: sourceVideoCodec,
      videoProfile: v?.profile?.toLowerCase(),
      videoLevel: v?.level,
      videoBitRate,
      formatBitRate,
      videoBitDepth: v?.bitDepth,
      width: v?.width,
      height: v?.height,
      frameRate: v?.frameRate,
      audioCodec: sourceAudioCodec,
      audioChannels: a?.channels,
      audioChannelLayout: a?.channelLayout,
      audioBitRate,
      audioSampleRate: a?.sampleRate,
      audioLanguage: a?.language,
      durationSeconds: si?.durationSeconds,
      hdrFormat: v?.hdrFormat as string | undefined,
      colorSpace: v?.colorSpace,
      colorTransfer: v?.colorTransfer,
      colorPrimaries: v?.colorPrimaries,
      crop: autoCropEnabled ? v?.crop : undefined,
    };

    // HDR / Dolby Vision detection
    const isSourceHdr = !!source.hdrFormat;
    const dv = deriveDvInfo(v);
    // Profile 5 (single-layer IPT-PQ-C2, no HDR10 base) decodes green/purple
    // wherever a non-DV client copies it, and its metadata often lives only in
    // the RPU (no HDR VUI), so it drives transcode+tonemap independently of
    // isSourceHdr — unless the client can present DV (see clientCanPresentDv).
    const dvP5 = isDvProfile5(dv);
    const clientSupportsHdr = profile.supportsHdr === true;
    // Codec selector: picks the variant the encoder pipeline will produce
    // when the playback path lands on transcode. The result is threaded by
    // the controller onto every later session spawn via
    // SessionContext.videoVariant. Only the first-ranked variant is emitted
    // (single codec per master); the rest is diagnostics.
    //
    // Carry the source HDR format in unconditionally: the selector + encoder
    // registry are the single source of truth for whether an HDR-preserving
    // encoder exists for a codec the client supports (HEVC Main10 on QSV,
    // AV1 via NVENC/libsvtav1, …). It returns an SDR variant when the client
    // lacks HDR display support or no HDR encoder is probed-OK.
    const detectedHwAccel = this.transcodingService.getDetectedHwAccel();
    const userAgent = ''; // UA-driven quirks plumbed via a later patch
    let selectedVariant = pickPrimaryVariant(
      {
        width: source.width ?? 0,
        height: source.height ?? 0,
        hdr: dvP5 ? null : ((source.hdrFormat as CodecVariant['hdr']) ?? null),
        codec: normaliseSourceCodec(source.videoCodec) ?? undefined,
      },
      profile,
      detectedHwAccel,
      userAgent,
    );
    // The transcode ladder preserves HDR exactly when the selector chose an
    // HDR variant. Codec-agnostic on both the source and the output side: an
    // HDR source routes to whatever HDR encoder the registry resolved for a
    // client-supported codec — HEVC Main10 on QSV/VAAPI/NVENC/VideoToolbox,
    // native AV1 HDR on NVENC Ada / libsvtav1 — and the master playlist
    // advertises that codec per rung (the `hdrPassThrough` branch switches the
    // CODECS string on `hdrVariant.codec`). `useHdrLadder` drives the HDR rung
    // naming and is threaded to the session by the controller.
    const useHdrLadder = selectedVariant.hdr != null;
    // Tone-map iff the source is HDR and the transcode ladder won't preserve
    // it (SDR client, or no HDR encoder for a client-supported codec). The
    // re-encode then runs the tonemap filter; copy paths (DirectPlay / remux)
    // never tone-map. AVPlayer rejects with -12927 if an H.264 re-encode
    // keeps the HDR VUI, hence the filter.
    const transcodeTonemaps = (isSourceHdr || dvP5) && !useHdrLadder;
    // useHdrLadder and selectedVariant are returned to the controller
    // via EvaluateResult; the controller threads them onto the live
    // session rather than the service writing side-effects.
    const wrap = (response: PlaybackInfoResponse): EvaluateResult => ({
      response,
      useHdrLadder,
      videoVariant: selectedVariant,
    });
    const needsBurnIn = !!burnInSubtitleId;
    // Cropping black bars forces a re-encode. When the admin disables auto-crop
    // (low-power servers), keep the bars and let the source Direct Play / remux.
    const needsCrop = !!source.crop;
    // …unless the client crops at its own video output, which costs nothing and
    // keeps the bitstream copyable. A session that re-encodes for another reason
    // still crops server-side — fewer pixels to encode — and the client leaves
    // it alone, keyed off `videoCopyStream`.
    const clientCropsBlackBars = profile.cropsBlackBarsLocally === true;

    const reasons: TranscodeReason[] = [];

    // --- Audio decision diagnostics ---
    // Tracks every input that influences the "copy vs transcode" branch so
    // we can see, from a single log line, why a 5.1 EAC-3 source ended up
    // being downmixed to AAC stereo.
    this.log.log(
      `audioDecision[file=${resolved.mediaFile.id}] source={codec=${source.audioCodec}, channels=${source.audioChannels}, layout=${source.audioChannelLayout}, bitrate=${source.audioBitRate}} profile={containers=${JSON.stringify(profile.directPlayProfiles.map((p) => p.containers))}, audioCodecs=${JSON.stringify(profile.directPlayProfiles.map((p) => p.audioCodecs))}, maxAudioChannels=${profile.maxAudioChannels}}`,
    );

    // --- Step 1: Try DirectPlay ---
    const directPlayResult = this.tryDirectPlay(source, profile, reasons);
    this.log.log(
      `audioDecision[file=${resolved.mediaFile.id}] tryDirectPlay → audioSupported=${directPlayResult.audioSupported}, containerSupported=${directPlayResult.containerSupported}, videoSupported=${directPlayResult.videoSupported}, reasons=${reasons.map((r) => r.flag).join('|') || '-'}`,
    );

    // Can the client present THIS HDR stream as-is? DirectPlay and remux copy
    // the video bitstream verbatim, so HDR survives for any codec — it only
    // needs an HDR display plus acceptance of the source codec at its bit
    // depth, which tryDirectPlay already validated via codecConditions
    // (videoConditionsMet covers the per-codec maxBitDepth). Decoupled from
    // the source codec on purpose: AV1, VP9 and HEVC 10-bit HDR all qualify.
    // A client that tone-maps HDR itself (desktop mpv on an SDR display) also
    // takes the bitstream verbatim — it just renders it in SDR.
    const clientCanPresentHdr =
      isSourceHdr &&
      !dvP5 &&
      (clientSupportsHdr || profile.tonemapsHdrLocally === true) &&
      directPlayResult.videoSupported &&
      directPlayResult.videoConditionsMet;

    // Single-layer DV (P5, P8.x) carries its RPU inside the HEVC NALs, so a raw
    // copy preserves DV for a client that declares it can present it. Dual-layer
    // P7's enhancement layer can't ride HLS, so dv.singleLayer excludes it.
    const clientCanPresentDv =
      profile.supportsDolbyVision === true &&
      dv.singleLayer &&
      directPlayResult.videoSupported &&
      directPlayResult.videoConditionsMet;
    const clientCanPresentDynamicRange =
      clientCanPresentHdr || clientCanPresentDv;
    // HDR reaches an SDR client that tone-maps on its own — copied through, or
    // re-encoded on the HDR ladder. Surfaced in the stats overlay and the admin
    // dashboard, which would otherwise show no HDR step at all.
    const clientTonemap =
      (clientCanPresentHdr || useHdrLadder) && !clientSupportsHdr;

    // HDR/DV the client can't present as-is forces a transcode. Flag the
    // tone-map only when the re-encode is actually SDR — when the HDR ladder
    // preserves it the real blocker is whatever tryDirectPlay already
    // recorded (resolution, level, …).
    if ((isSourceHdr || dvP5) && !clientCanPresentDynamicRange) {
      if (directPlayResult.canDirectPlay)
        directPlayResult.canDirectPlay = false;
      this.log.log(
        `hdrDecision[file=${resolved.mediaFile.id}] ${dvP5 ? 'Dolby Vision P5' : source.hdrFormat} → SDR: supportsHdr=${clientSupportsHdr}, tonemapsHdrLocally=${profile.tonemapsHdrLocally === true}, supportsDolbyVision=${profile.supportsDolbyVision === true}, videoSupported=${directPlayResult.videoSupported}, videoConditionsMet=${directPlayResult.videoConditionsMet}`,
      );
      if (transcodeTonemaps) {
        reasons.push({
          flag: 'VideoHdrNotSupported',
          message: `HDR → SDR (tone mapping ${dvP5 ? 'Dolby Vision P5' : source.hdrFormat})`,
        });
      }
    }

    // Subtitle burn-in forces transcode
    if (needsBurnIn) {
      if (directPlayResult.canDirectPlay)
        directPlayResult.canDirectPlay = false;
      reasons.push({
        flag: 'SubtitleBurnIn',
        message: 'Subtitles burned into the video',
      });
    }

    // Crop (black bar removal) forces transcode
    if (needsCrop && !clientCropsBlackBars) {
      if (directPlayResult.canDirectPlay)
        directPlayResult.canDirectPlay = false;
      reasons.push({
        flag: 'VideoCrop',
        message: 'Removing black bars (crop)',
      });
    }

    // --- Quality / engine routing gate ---
    // The full quality ladder is always exposed (see buildQualityList). Direct
    // Play — and remux at source resolution — is only what the client wants
    // when it asks for the source rung. A lower explicit rung routes to the
    // transcode ladder; "Auto" routes there too when the admin picked
    // autoQualityMode='abr'. HLS-only engines (Tizen AVPlay) can never open a
    // raw file, so they skip DirectPlay but still remux to HLS.
    const deviceType: DeviceType = profile.deviceType ?? 'desktop';
    const ladder = getLadderForDevice(deviceType);
    // Quality ladder shown to the UI matches what the backend will
    // actually serve: HDR sessions emit the HDR ladder (2160p/1080p/
    // 720p/480p-hdr — no 360p/240p/144p rungs). Exposing the SDR
    // ladder in HDR mode let users pick rungs that don't exist; the
    // pin then failed to match, fell back to the full ladder, and the
    // master ABR-ran across every HDR rung.
    const qualityLadder = useHdrLadder
      ? getHdrLadderForDevice(deviceType)
      : ladder;
    const wantsSourceRung =
      requestedQuality == null ||
      requestedQuality === 'auto' ||
      requestedQuality === 'original';
    const autoOnLadder =
      (requestedQuality == null || requestedQuality === 'auto') &&
      autoQualityMode === 'abr';
    // An explicit rung only forces the transcode ladder when it actually steps
    // below the source: a lower resolution, or an eco (same-resolution,
    // reduced-bitrate) rung the user deliberately picked. A rung at the source
    // resolution — e.g. a '1080p' id carried over from another title onto a
    // 1080p source — is the source rung, so it stays DirectPlay-eligible
    // instead of re-encoding 1080p→1080p for nothing. ABR-on-auto still routes
    // to the ladder.
    const explicitRung = wantsSourceRung
      ? undefined
      : resolveLadderRung(requestedQuality as string, qualityLadder);
    // Rung this session locks in, in `qualities` ids. The client mirrors its
    // selector on it instead of re-deriving one from the stored preference,
    // which cannot see which ladder the backend ended up on.
    const negotiatedQuality = explicitRung?.name ?? 'auto';
    const explicitDownscale =
      !!explicitRung &&
      (bucketResolutionHeight(explicitRung.maxWidth, explicitRung.maxHeight) <
        bucketResolutionHeight(source.width, source.height) ||
        isEcoProfile(explicitRung.name));
    const forceLadder = autoOnLadder || explicitDownscale;

    // Whether the source can be served at its own resolution without
    // re-encoding (raw direct play or codec-copy remux). Independent of the
    // quality gate so the `original` rung stays in the menu even while the user
    // is currently watching a lower transcoded rung — letting them switch back.
    const sourceCopyable =
      directPlayResult.videoSupported &&
      directPlayResult.videoConditionsMet &&
      ((!isSourceHdr && !dvP5) || clientCanPresentDynamicRange) &&
      !needsBurnIn &&
      (!needsCrop || clientCropsBlackBars);

    if (profile.supportsDirectPlay === false && directPlayResult.canDirectPlay) {
      directPlayResult.canDirectPlay = false;
      reasons.push({
        flag: 'ClientRequiresHls',
        message: 'Client requires an HLS container (no raw direct play)',
      });
    }
    // A raw file plays its first audio track; HLS lets the picked one lead.
    if (
      pickedAudio !== 0 &&
      profile.switchesDirectPlayAudio === false &&
      directPlayResult.canDirectPlay
    ) {
      directPlayResult.canDirectPlay = false;
      reasons.push({
        flag: 'ClientCannotSwitchAudio',
        message: 'Client cannot switch audio tracks inside a raw file',
      });
    }
    if (forceLadder) {
      if (directPlayResult.canDirectPlay)
        directPlayResult.canDirectPlay = false;
      // ABR mode is a `Video*` reason so the overlay surfaces it in the video
      // section. The explicit-rung case adds VideoQualityReduced below, but
      // only when the rung genuinely downscales resolution or cuts bitrate vs
      // the source — picking a fixed rung is not itself a transcode reason.
      if (autoOnLadder) {
        reasons.push({ flag: 'VideoAbr', message: 'Adaptive bitrate (ABR) mode' });
      }
    }

    // An explicit rung only reaches this branch via `explicitDownscale` — a
    // lower resolution or an eco (same-resolution, reduced-bitrate) tier the
    // user deliberately picked, both of which re-encode the video. Surface the
    // choice so the overlay never shows a transcode with an empty video reason.
    // (A per-bitrate re-check used to gate this and silently dropped the reason
    // for eco rungs whose source-capped bitrate wasn't provably below an
    // unknown or already-low source bitrate.)
    if (forceLadder && !autoOnLadder) {
      const rung = qualityLadder.find((p) => p.name === requestedQuality);
      if (rung) {
        reasons.push({
          flag: 'VideoQualityReduced',
          message: `Reduced-quality rung selected (${requestedQuality})`,
        });
      }
    }

    if (directPlayResult.canDirectPlay) {
      this.log.log(
        `DirectPlay for file ${resolved.mediaFile.id}: ${sourceContainer}/${sourceVideoCodec}/${sourceAudioCodec}`,
      );
      const url = `/api/stream/${resolved.mediaFile.id}${tokenParam}`;
      return wrap({
        mediaFileId: resolved.mediaFile.id,
        playMethod: 'DirectPlay',
        playUrl: url,
        contentType: resolved.contentType,
        transcodeReasons: [],
        videoCopyStream: true,
        audioCopyStream: true,
        outputVideoCodec: sourceVideoCodec,
        outputAudioCodec: sourceAudioCodec,
        audioPlan: { mode: 'copy', codec: sourceAudioCodec },
        outputContainer: sourceContainer,
        quality: 'original',
        hwAccel: 'none',
        tonemapping: false,
        clientTonemap,
        qualities: this.buildQualityList(
          source,
          'DirectPlay',
          sourceCopyable,
          qualityLadder,
          selectedVariant.codec,
        ),
        audioTracks: this.buildAudioTracks(
          si,
          profile,
          'DirectPlay',
          'fmp4',
          sourceContainer,
        ),
        source,
      });
    }

    // --- HLS audio (DirectStream and Transcode alike) ---
    // One decision per track; the top-level plan and reasons are the picked
    // track's, so they can never disagree with `audioTracks`.
    const hlsMux = resolveMuxFlavour(profile, audioStreams.length);
    const audioTracks = this.buildAudioTracks(
      si,
      profile,
      'Transcode',
      hlsMux,
      sourceContainer,
    );
    const pickedTrack = audioTracks[pickedAudio];
    const stereoAudioBps = parseBitrateToBps(ladder[0]?.audioBitrate ?? '192k');
    const audioPlan: AudioPlan = pickedTrack
      ? toAudioPlan(pickedTrack, stereoAudioBps)
      : {
          mode: 'transcode',
          codec: 'aac',
          bitrateBps: stereoAudioBps,
          channels: 2,
        };
    const canCopyAudio = audioPlan.mode === 'copy';
    const outputAudioCodec = audioPlan.codec;
    reasons.push(
      ...(pickedTrack?.reasonFlags ?? []).map((f) =>
        audioReason(f, pickedTrack),
      ),
    );

    // --- Step 2: Try DirectStream (remux) ---
    // Video codec must be supported; only container or audio may differ
    // Cannot remux if tone mapping or burn-in is needed (video must be re-encoded).
    // A lower explicit rung / ABR-on-auto wants a re-encoded ladder, not a
    // source-resolution remux copy, so `forceLadder` skips this path too.
    // Dolby Vision Profile 5 is never remuxed: the fMP4 muxer drops the DV
    // configuration box on `-c:v copy`, so a copied P5 (whose base layer isn't
    // valid HDR10) would render green/purple. P5 rides raw DirectPlay (whole
    // original file, DV intact) or a tonemap transcode instead — never remux.
    const canCopyVideo = sourceCopyable && !forceLadder && !dvP5;
    if (canCopyVideo) {
      if (
        !directPlayResult.containerSupported &&
        !reasons.some((r) => r.flag === 'ContainerNotSupported')
      ) {
        reasons.push({
          flag: 'ContainerNotSupported',
          message: `Container "${sourceContainer}" not supported`,
        });
      }

      this.log.log(
        `DirectStream (remux) for file ${resolved.mediaFile.id}: copy video, ${canCopyAudio ? 'copy' : 'transcode'} audio`,
      );
      const sep = tokenParam ? '&' : '?';
      const url = `/api/stream/${resolved.mediaFile.id}/master.m3u8${tokenParam}${sep}remux=1`;
      const remuxBw =
        source.formatBitRate ??
        (source.videoBitRate ?? 0) + (source.audioBitRate ?? 0);
      // Same scale as the master playlist's transcoded rungs — exposes
      // a bitrate hint per quality so the stats overlay can plot the
      // selected rung without re-deriving the bitrate ladder client-side.
      const transcodeBitrateByQuality: NonNullable<
        PlaybackInfoResponse['transcodeBitrateByQuality']
      > = {};
      // Key by the ladder actually offered (HDR rungs carry the `-hdr`
      // suffix) so the stats overlay can resolve the selected rung's bitrate.
      // Using the SDR `ladder` here left HDR / eco-hdr rungs unmatched, and
      // the overlay fell back to the full remux bandwidth.
      const rungCtx = this.rungBitrateCtx(source, selectedVariant.codec);
      for (const p of qualityLadder) {
        const videoBps = cappedRungVideoBitrateBps(p, rungCtx);
        const audioBps = parseBitrateToBps(p.audioBitrate);
        transcodeBitrateByQuality[p.name] = {
          videoBitrateBps: videoBps,
          audioBitrateBps: audioBps,
          totalBitrateBps: videoBps + audioBps,
        };
      }
      return wrap({
        mediaFileId: resolved.mediaFile.id,
        playMethod: 'DirectStream',
        playUrl: url,
        contentType: 'application/vnd.apple.mpegurl',
        transcodeReasons: reasons,
        videoCopyStream: true,
        audioCopyStream: canCopyAudio,
        outputVideoCodec: sourceVideoCodec,
        outputAudioCodec,
        audioPlan,
        outputContainer: 'hls',
        quality: 'original',
        // Report the backend's detected hwAccel even on the remux path:
        // the stats overlay binds this to the active *quality* (remux →
        // "Direct playback" / transcode rung → "Transcoding (<HW>)"). A
        // hard-coded 'none' here surfaced as "Transcoding (CPU)" as soon
        // as the user switched to a transcoded rung (e.g. 1080p-hdr via
        // hevc_qsv main10), since the field is stale for the new session.
        hwAccel: this.transcodingService.getDetectedHwAccel(),
        tonemapping: false,
        clientTonemap,
        remuxMasterBandwidthBps: remuxBw > 0 ? remuxBw : undefined,
        transcodeBitrateByQuality,
        qualities: this.buildQualityList(source, 'DirectStream', sourceCopyable, qualityLadder, selectedVariant.codec),
        audioTracks,
        source,
      });
    }

    // --- Step 3: Full Transcode ---
    if (
      transcodeTonemaps &&
      !reasons.some((r) => r.flag === 'VideoHdrNotSupported')
    ) {
      reasons.push({
        flag: 'VideoHdrNotSupported',
        message: `HDR → SDR (tone mapping ${source.hdrFormat})`,
      });
    }
    // Report the encoder that will actually run via the SAME resolver
    // ffmpeg-args uses, so the stats hwAccel can't drift from the real encode
    // (it picks up the registry's runtime CPU fallback and the QSV crop→VAAPI
    // splice). Same inputs the session will carry, so the result matches.
    const effectiveHwAccel = resolveEncodePipeline(selectedVariant, {
      hwAccel: this.transcodingService.getDetectedHwAccel(),
      crop: needsCrop,
      burnIn: needsBurnIn,
      tonemap: transcodeTonemaps,
      tonemapAlgo: this.activeStreamTracker.getTonemapAlgo(),
      sourceVideoCodec,
    }).effectiveHwAccel;

    const outputAudioBitrateBps =
      audioPlan.mode === 'copy' ? (source.audioBitRate ?? 0) : audioPlan.bitrateBps;

    this.log.log(
      `Transcode for file ${resolved.mediaFile.id}: ${reasons.map((r) => r.flag).join(', ')} (audioOut=${outputAudioCodec}, copy=${canCopyAudio}, track=${pickedAudio})`,
    );
    const url = `/api/stream/${resolved.mediaFile.id}/master.m3u8${tokenParam}`;
    const transcodeBitrateByQuality: NonNullable<
      PlaybackInfoResponse['transcodeBitrateByQuality']
    > = {};
    // Key by the offered ladder (HDR/eco-hdr rungs carry `-hdr`) so the stats
    // overlay resolves the selected rung instead of falling back to the full
    // remux bandwidth.
    const rungCtx = this.rungBitrateCtx(source, selectedVariant.codec);
    for (const p of qualityLadder) {
      const videoBps = cappedRungVideoBitrateBps(p, rungCtx);
      const audioBps = outputAudioBitrateBps ?? parseBitrateToBps(p.audioBitrate);
      transcodeBitrateByQuality[p.name] = {
        videoBitrateBps: videoBps,
        audioBitrateBps: audioBps,
        totalBitrateBps: videoBps + audioBps,
      };
    }
    return wrap({
      mediaFileId: resolved.mediaFile.id,
      playMethod: 'Transcode',
      playUrl: url,
      contentType: 'application/vnd.apple.mpegurl',
      transcodeReasons: reasons,
      videoCopyStream: false,
      audioCopyStream: canCopyAudio,
      outputVideoCodec: selectedVariant.codec,
      outputAudioCodec,
      audioPlan,
      outputContainer: 'hls',
      quality: negotiatedQuality,
      hwAccel: effectiveHwAccel,
      tonemapping: transcodeTonemaps,
      clientTonemap,
      transcodeBitrateByQuality,
      qualities: this.buildQualityList(source, 'Transcode', sourceCopyable, qualityLadder, selectedVariant.codec),
      audioTracks,
      source,
    });
  }

  /** Per-rung bitrate context from the source + chosen output codec, so the
   *  playback-info bitrate hints go through the same cappedRungVideoBitrateBps
   *  as the manifest BANDWIDTH and the encoder (cap + HEVC Main-tier clamp). */
  private rungBitrateCtx(
    source: PlaybackInfoResponse['source'],
    outputCodec: string | undefined,
  ): RungBitrateContext {
    return {
      outputCodec,
      sourceWidth: source.width ?? 0,
      sourceHeight: source.height ?? 0,
      sourceFrameRate: parseSourceFps(source.frameRate) ?? 24,
      sourceVideoBitrateBps: source.videoBitRate,
      sourceVideoCodec: source.videoCodec,
    };
  }

  /**
   * Build the server-authoritative quality list shown in the player UI.
   *
   * The full ladder is always exposed (DirectPlay included) so the user can
   * downshift to a transcoded rung; picking a rung below source re-negotiates
   * playback to the HLS ladder. Rules:
   * - The source-resolution rung is `original` (raw on DirectPlay, copy on
   *   DirectStream — only the latter sets `isRemux`).
   * - Iterate the device ladder filtered to source.
   *   At the source-resolution rung:
   *     - If remux is possible (`videoCopyStream`) and `sourceTotal > ladderTotal × 1.3`:
   *       expose BOTH entries, `original` first (the remux path, full quality) and
   *       then the transcode rung flagged `lowBandwidth` so the UI can hint at it.
   *     - If remux is possible but source bitrate is near/below ladder: collapse to
   *       a single `original` entry (labelled with the resolution alone).
   *     - If remux is NOT possible (full transcode path): expose only the transcode rung.
   *   Below source resolution: regular transcode rungs, unchanged.
   */
  private buildQualityList(
    source: PlaybackInfoResponse['source'],
    playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode',
    videoCopyStream: boolean,
    ladder: TranscodeProfile[],
    targetCodec?: string,
  ): QualityOption[] {
    const sourceW = source.width ?? 0;
    const sourceH = source.height ?? 0;
    const sourceTotal =
      source.formatBitRate ??
      (source.videoBitRate ?? 0) + (source.audioBitRate ?? 0);

    const available = ladder.filter((p) =>
      profileFitsSource(p, sourceW, sourceH),
    );
    if (!available.length) available.push(ladder[ladder.length - 1]);
    const displayLabel = (name: string) => {
      const stripped = name.replace(/^eco-/, '').replace(/-hdr$/, '');
      return stripped === '2160p' ? '4K' : stripped;
    };
    // Transcode rungs are capped to the source bitrate (codec-aware), matching
    // the encode and the master BANDWIDTH — a forced transcode never inflates a
    // low-bitrate source up to the rung nominal, so the stats overlay (which
    // reads this list) shows the real target.
    const rungCtx = this.rungBitrateCtx(source, targetCodec);
    const totalOf = (p: TranscodeProfile) =>
      cappedRungVideoBitrateBps(p, rungCtx) + parseBitrateToBps(p.audioBitrate);

    // First non-eco entry = the source-resolution (top) rung.
    const topProfile =
      available.find((p) => !isEcoProfile(p.name)) ?? available[0];
    const resolutionLabel = displayLabel(topProfile.name);
    const originalHeight = sourceH || topProfile.maxHeight;
    const originalWidth = sourceW || topProfile.maxWidth;

    // Full-quality rungs. The top rung collapses into `original` when the
    // source video can be served untouched (DirectPlay) or copied (remux);
    // a forced transcode lists it as a normal rung instead. `isRemux` is true
    // only on the DirectStream path so the UI/stats can tell remux from a raw
    // direct play.
    // Track a resolution `tier` (the profile's bucket maxHeight) alongside each
    // rung, kept separate from the displayed height. The source-resolution
    // `original` rung carries the actual source height, which for a letterboxed
    // / scope source (e.g. a 3840×1606 4K) is below its own eco rung's bucket
    // height (2160) — sorting on raw height would then list "4K eco" above "4K".
    const entries: { option: QualityOption; tier: number }[] = [];
    for (const p of available) {
      if (isEcoProfile(p.name)) continue;
      const total = totalOf(p);
      if (p.name === topProfile.name && videoCopyStream) {
        entries.push({
          option: {
            id: 'original',
            label: resolutionLabel,
            height: originalHeight,
            width: originalWidth,
            totalBitrateBps: sourceTotal > 0 ? sourceTotal : total,
            isRemux: playMethod === 'DirectStream',
          },
          tier: p.maxHeight,
        });
        continue;
      }
      entries.push({
        option: {
          id: p.name,
          label: displayLabel(p.name),
          height: p.maxHeight,
          width: p.maxWidth,
          totalBitrateBps: total,
          isRemux: false,
        },
        tier: p.maxHeight,
      });
    }

    // Low-consumption rungs at every fitting resolution (4K eco, 1080p eco,
    // 720p eco…). Same on every device. Gated on the source VIDEO bitrate: an
    // eco rung is only worth a forced re-encode when it genuinely shrinks the
    // video. Comparing against the source TOTAL would wrongly offer an eco rung
    // whose only "saving" is a fat audio track (downmixed on any rung anyway),
    // re-encoding the video for no gain. Falls back to total-vs-total when the
    // source video bitrate is unknown.
    const sourceVideoBps = resolveSourceVideoBitrateBps(
      source.videoBitRate,
      source.formatBitRate,
      source.audioBitRate ?? 0,
    );
    const savingRef = sourceTotal > 0 ? sourceTotal : totalOf(topProfile);
    for (const p of available) {
      if (!isEcoProfile(p.name)) continue;
      const reducesVideo =
        sourceVideoBps && sourceVideoBps > 0
          ? cappedRungVideoBitrateBps(p, rungCtx) < sourceVideoBps
          : totalOf(p) < savingRef;
      if (!reducesVideo) continue;
      entries.push({
        option: {
          id: p.name,
          label: displayLabel(p.name),
          height: p.maxHeight,
          width: p.maxWidth,
          totalBitrateBps: totalOf(p),
          isRemux: false,
          lowBandwidth: true,
        },
        tier: p.maxHeight,
      });
    }

    // Order by resolution tier (descending), then the full rung before its
    // low-consumption sibling, then bitrate — so an eco rung always follows the
    // normal rung of the same resolution: 4K, 4K eco, 1080p, 1080p eco, 720p, …
    entries.sort(
      (a, b) =>
        b.tier - a.tier ||
        Number(!!a.option.lowBandwidth) - Number(!!b.option.lowBandwidth) ||
        (b.option.totalBitrateBps ?? 0) - (a.option.totalBitrateBps ?? 0),
    );

    return entries.map((e) => e.option);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Per-track audio copy/transcode decision for every source audio stream,
   * in `streamInfo.audio` order — the only place audio is decided.
   *
   * For HLS output (DirectStream / Transcode) every rendition of the audio
   * group MUST share one OUTPUT codec — a master playlist carries a single
   * CODECS string and players (AVPlayer, Shaka) reject a group whose
   * renditions disagree. So the group picks one output codec
   * ({@link pickGroupAudioCodec}) and each rendition either copies (its source
   * already IS that codec and fits the channel cap) or transcodes to it,
   * downmixing to what both the device and the encoder take. DirectPlay copies
   * everything (raw file).
   */
  private buildAudioTracks(
    si: MediaFileInfo | null | undefined,
    profile: DeviceProfileDto,
    playMethod: PlayMethod,
    muxFlavour: 'ts' | 'fmp4',
    container: string,
  ): AudioTrackPlan[] {
    const audioStreams = si?.audio ?? [];
    const video = si?.video?.[0];
    const blockers = audioStreams.map((t) =>
      copyBlocker(t, video, muxFlavour, container),
    );
    const profileAudioCodecs = profile.directPlayProfiles
      .flatMap((p) => p.audioCodecs)
      .map((c) => c.toLowerCase());
    const groupCodec = this.pickGroupAudioCodec(
      audioStreams,
      profile,
      profileAudioCodecs,
      blockers.some(Boolean),
    );
    const outCap = isEncodableAudio(groupCodec)
      ? Math.min(
          audioChannelCap(profile, groupCodec),
          encoderMaxChannels(groupCodec),
        )
      : audioChannelCap(profile, groupCodec);

    return audioStreams.map((t, index) => {
      const codec = (t.codec ?? '').toLowerCase();
      const channels = t.channels;
      const base = { index, language: t.language, codec, channels };
      const codecSupported = profileAudioCodecs.includes(codec);
      const fmp4Safe = FMP4_COMPATIBLE_AUDIO.has(codec);
      // Fits for a verbatim copy only within ITS OWN codec's decode cap (a
      // device may decode AAC 7.1 but EAC-3 only 5.1).
      const channelsExceed =
        channels != null && channels > audioChannelCap(profile, codec);
      const blocker = blockers[index];

      // DirectPlay serves the raw file — every track plays natively.
      if (playMethod === 'DirectPlay') {
        return {
          ...base,
          copy: true,
          outputCodec: codec,
          outputChannels: channels,
          reasonFlags: [],
        };
      }

      const copyable =
        codec === groupCodec && codecSupported && fmp4Safe && !channelsExceed;
      if (copyable && !blocker) {
        return {
          ...base,
          copy: true,
          outputCodec: groupCodec,
          outputChannels: channels,
          reasonFlags: [],
        };
      }
      const outputChannels = Math.min(channels ?? 2, outCap);
      const downmixed = channels != null && outputChannels < channels;
      const surroundPreserved = groupCodec !== 'aac' && outputChannels >= 6;
      // A track plays as-is only if the device decodes it AND it's fMP4-safe
      // (MP3 is device-decodable but not fMP4-safe, so it must transcode — a
      // genuine reason, unlike a codec re-encoded only to match the group).
      const playableAsIs = codecSupported && fmp4Safe;
      // A supported codec that's only downmixed shows the channel reason
      // alone; a codec re-encoded purely to match the group's output codec
      // (playable as-is, or saved as surround) shows no codec reason.
      const reasonFlags: string[] = [];
      if (downmixed) {
        reasonFlags.push('AudioChannelsNotSupported');
      }
      if (!playableAsIs && !surroundPreserved) {
        reasonFlags.push('AudioCodecNotSupported');
      }
      if (blocker) {
        reasonFlags.push(blocker);
      }
      return {
        ...base,
        copy: false,
        outputCodec: groupCodec,
        outputChannels,
        reasonFlags,
      };
    });
  }

  /**
   * Pick the single OUTPUT codec shared by every rendition of an audio group
   * (HLS requires one codec per group). Copy-all when every track is the same
   * supported, fMP4-safe codec that fits the channel cap — that codec is the
   * output and nothing re-encodes. Otherwise the best the device accepts: a
   * surround codec (EAC-3 > AC-3) when any track carries surround so 5.1/7.1
   * survive, else AAC.
   */
  private pickGroupAudioCodec(
    audioStreams: { codec?: string; channels?: number }[],
    profile: DeviceProfileDto,
    profileAudioCodecs: string[],
    anyCopyBlocked: boolean,
  ): string {
    const codecs = audioStreams.map((t) => (t.codec ?? '').toLowerCase());
    // All renditions share one source codec the device plays in fMP4: keep it
    // so the fitting tracks copy and only an over-capacity or blocked one
    // re-encodes, to the same codec — which needs an encoder for it (an
    // all-Opus group stays Opus instead of re-encoding every track to E-AC-3).
    if (codecs.length > 0 && new Set(codecs).size === 1) {
      const c = codecs[0];
      const supported =
        profileAudioCodecs.includes(c) && FMP4_COMPATIBLE_AUDIO.has(c);
      const allFit = audioStreams.every(
        (t) => t.channels == null || t.channels <= audioChannelCap(profile, c),
      );
      const allCopy = allFit && !anyCopyBlocked;
      if (supported && (allCopy || isEncodableAudio(c))) return c;
    }
    const anySurround = audioStreams.some((t) => (t.channels ?? 0) >= 6);
    const surround = (['eac3', 'ac3'] as const).find(
      (c) =>
        profileAudioCodecs.includes(c) &&
        Math.min(audioChannelCap(profile, c), encoderMaxChannels(c)) >= 6,
    );
    return anySurround && surround ? surround : 'aac';
  }

  private tryDirectPlay(
    source: PlaybackInfoResponse['source'],
    profile: DeviceProfileDto,
    reasons: TranscodeReason[],
  ): {
    canDirectPlay: boolean;
    containerSupported: boolean;
    videoSupported: boolean;
    audioSupported: boolean;
    videoConditionsMet: boolean;
  } {
    let containerSupported = false;
    let videoSupported = false;
    let audioSupported = false;

    // Per-flag support across all profiles — kept for DirectStream's per-codec
    // copy decision and the reason messages below (those answer "is this codec
    // playable at all", independent of container).
    for (const dp of profile.directPlayProfiles) {
      if (dp.containers.includes(source.container)) containerSupported = true;
      if (dp.videoCodecs.includes(source.videoCodec)) videoSupported = true;
      if (dp.audioCodecs.includes(source.audioCodec)) audioSupported = true;
    }

    // Direct Play requires ONE profile entry to bind all three together — a
    // container from one entry paired with a codec from another is a
    // combination the device never claimed it can play as-is.
    const boundMatch = profile.directPlayProfiles.some(
      (dp) =>
        dp.containers.includes(source.container) &&
        dp.videoCodecs.includes(source.videoCodec) &&
        dp.audioCodecs.includes(source.audioCodec),
    );

    // Check fine-grained codec conditions on video
    let videoConditionsMet = true;
    if (videoSupported && profile.codecConditions?.length) {
      const cond = profile.codecConditions.find(
        (c) => c.codec === source.videoCodec,
      );
      if (cond) {
        if (
          cond.maxLevel &&
          source.videoLevel &&
          source.videoLevel > cond.maxLevel
        ) {
          videoConditionsMet = false;
          reasons.push({
            flag: 'VideoLevelNotSupported',
            message: `Level ${source.videoLevel} > max ${cond.maxLevel}`,
          });
        }
        if (
          cond.profiles?.length &&
          source.videoProfile &&
          !cond.profiles.includes(source.videoProfile)
        ) {
          videoConditionsMet = false;
          reasons.push({
            flag: 'VideoProfileNotSupported',
            message: `Video profile "${source.videoProfile}" not supported`,
          });
        }
        if (
          cond.maxBitDepth &&
          source.videoBitDepth &&
          source.videoBitDepth > cond.maxBitDepth
        ) {
          videoConditionsMet = false;
          reasons.push({
            flag: 'VideoBitDepthNotSupported',
            message: `${source.videoBitDepth} bit > max ${cond.maxBitDepth} bit`,
          });
        }
        if (
          !resolutionFitsCap(
            source.width,
            source.height,
            cond.maxWidth,
            cond.maxHeight,
          )
        ) {
          videoConditionsMet = false;
          reasons.push({
            flag: 'VideoResolutionNotSupported',
            message: `Resolution ${source.width}x${source.height} > max ${cond.maxWidth ?? '?'}x${cond.maxHeight ?? '?'}`,
          });
        }
      }
    }

    // Bitrate check
    if (profile.maxStreamingBitrate && profile.maxStreamingBitrate > 0) {
      const totalBitrate =
        source.formatBitRate ??
        (source.videoBitRate ?? 0) + (source.audioBitRate ?? 0);
      if (totalBitrate > profile.maxStreamingBitrate) {
        reasons.push({
          flag: 'VideoBitrateNotSupported',
          message: `Bitrate too high (${Math.round(totalBitrate / 1_000_000)} Mbps)`,
        });
        videoConditionsMet = false;
      }
    }

    // Against the source codec's own decode cap. The audio reasons come from
    // the per-track plan once Direct Play is off the table.
    const audioCap = audioChannelCap(profile, source.audioCodec);
    if (source.audioChannels && source.audioChannels > audioCap) {
      audioSupported = false;
    }

    if (!videoSupported) {
      reasons.push({
        flag: 'VideoCodecNotSupported',
        message: `Codec "${source.videoCodec}" not supported`,
      });
    }
    if (!containerSupported) {
      reasons.push({
        flag: 'ContainerNotSupported',
        message: `Container "${source.container}" not supported`,
      });
    }

    // boundMatch already implies container + video + audio are supported (in one
    // entry); audioSupported additionally carries the channel-count constraint.
    const canDirectPlay = boundMatch && audioSupported && videoConditionsMet;
    return {
      canDirectPlay,
      containerSupported,
      videoSupported,
      audioSupported,
      videoConditionsMet,
    };
  }
}
