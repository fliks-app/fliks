import { Injectable, Logger } from '@nestjs/common';
import { DeviceProfileDto } from './dto/device-profile.dto';
import {
  PlaybackInfoResponse,
  QualityOption,
  TranscodeReason,
} from './dto/playback-info.dto';
import { ResolvedFile } from './streaming.service';
import {
  DeviceType,
  TranscodeProfile,
  TranscodingService,
  encoderRegistry,
  getHdrLadderForDevice,
  getLadderForDevice,
  isEcoProfile,
  parseBitrateToBps,
  profileFitsSource,
  requestedHwAccelFor,
} from './transcoding';
import { isDecoderEnabled } from './transcoding/codec/decoder-probe';
import { isVppQsvTonemapEnabled } from './transcoding/codec/vpp-qsv-probe';
import { normaliseSourceCodec } from './transcoding/codec/normalise';
import { pickPrimaryVariant } from './transcoding/codec/selector';
import type { CodecVariant, VideoCodec } from './transcoding/codec/types';

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
  ): EvaluateResult {
    const si = resolved.mediaFile.streamInfo;
    const v = si?.video?.[0];
    const a = si?.audio?.[0];
    const formatBitRate =
      si?.formatBitRate != null && si.formatBitRate > 0
        ? si.formatBitRate
        : undefined;
    const audioStreams = si?.audio ?? [];
    const audioSumBitrate = audioStreams.reduce(
      (sum, s) => sum + (s.bitRate ?? 0),
      0,
    );

    let videoBitRate = v?.bitRate;
    if (videoBitRate == null && formatBitRate != null) {
      if (audioSumBitrate > 0) {
        const est = formatBitRate - audioSumBitrate;
        if (est > 10_000) videoBitRate = est;
      }
    }

    let audioBitRate = a?.bitRate;
    if (audioBitRate == null && formatBitRate != null && videoBitRate != null) {
      const leftover = formatBitRate - videoBitRate;
      if (leftover > 1_000) audioBitRate = leftover;
    }

    const sourceContainer = resolved.ext.replace('.', '').toLowerCase();
    const sourceVideoCodec = (v?.codec ?? '').toLowerCase();
    const sourceAudioCodec = (a?.codec ?? '').toLowerCase();

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
      crop: v?.crop,
    };

    // HDR detection
    const isSourceHdr = !!source.hdrFormat;
    const clientSupportsHdr = profile.supportsHdr === true;
    // HEVC HDR ladder eligibility. Triggers a separate master.m3u8 path
    // (HEVC Main10 transcodes carrying BT.2020/PQ in their VUI) instead
    // of the H.264 SDR ladder. Gated by:
    //   - Source video codec is HEVC (only codec we re-encode while
    //     preserving HDR signaling in HLS).
    //   - Client claims HDR support (browser-device-profile sourced from
    //     `AVPlayer.eligibleForHDRPlayback` on iOS, MediaCapabilities on
    //     web/Android).
    // Encoder availability is checked downstream by the codec selector
    // via `encoderRegistry.resolve()` — deployments without a working
    // hevc_qsv Main10 path automatically fall back to libx265 (or to
    // H.264 SDR if the source isn't HEVC).
    const useHdrLadder =
      isSourceHdr && clientSupportsHdr && sourceVideoCodec === 'hevc';
    // Tone-map iff the source is HDR and we're not routing through the
    // HDR ladder. Anything that re-encodes via H.264 needs the tonemap
    // filter or AVPlayer rejects with -12927 (mismatched VUI vs codec).
    const needsTonemapping = isSourceHdr && !useHdrLadder;

    // Codec selector: picks the variant the encoder pipeline will produce
    // when the playback path lands on transcode. The result is stored in
    // the tracker so the controller can thread it into every later
    // session spawn via SessionContext.videoVariant. Today only the
    // first-ranked variant is emitted (single codec per master); the
    // remainder is kept in diagnostics. Source HDR + HEVC source still
    // routes through `useHdrLadder` for backward compat — the selector's
    // job here is to give the encoder layer an explicit variant target
    // rather than rely on profile-name inference.
    const detectedHwAccel = this.transcodingService.getDetectedHwAccel();
    const userAgent = ''; // UA-driven quirks plumbed via a later patch
    const selectedVariant = pickPrimaryVariant(
      {
        width: source.width ?? 0,
        height: source.height ?? 0,
        // Only carry HDR into the variant when we actually emit the HDR ladder.
        // An HDR source tonemapped to SDR (useHdrLadder=false) is encoded as an
        // 8-bit SDR variant, so selecting an HDR (Main10) variant here
        // mismatches the real encoder — which left effectiveHwAccel resolving to
        // the CPU fallback (stats showed "CPU") while ffmpeg actually ran
        // hevc_qsv.
        hdr: useHdrLadder ? ((source.hdrFormat as CodecVariant['hdr']) ?? null) : null,
        codec: normaliseSourceCodec(source.videoCodec) ?? undefined,
      },
      profile,
      detectedHwAccel,
      userAgent,
    );
    // useHdrLadder and selectedVariant are returned to the controller
    // via EvaluateResult; the controller threads them onto the live
    // session rather than the service writing side-effects.
    const wrap = (response: PlaybackInfoResponse): EvaluateResult => ({
      response,
      useHdrLadder,
      videoVariant: selectedVariant,
    });
    const needsBurnIn = !!burnInSubtitleId;
    const needsCrop = !!v?.crop;

    const reasons: TranscodeReason[] = [];

    // --- Audio decision diagnostics ---
    // Tracks every input that influences the "copy vs transcode" branch so
    // we can see, from a single log line, why a 5.1 EAC-3 source ended up
    // being downmixed to AAC stereo.
    this.log.log(
      `audioDecision[file=${resolved.mediaFile.id}] source={codec=${source.audioCodec}, channels=${source.audioChannels}, layout=${source.audioChannelLayout}, bitrate=${source.audioBitRate}} profile={audioCodecs=${JSON.stringify(profile.directPlayProfiles.map((p) => p.audioCodecs))}, maxAudioChannels=${profile.maxAudioChannels}}`,
    );

    // --- Step 1: Try DirectPlay ---
    const directPlayResult = this.tryDirectPlay(source, profile, reasons);
    this.log.log(
      `audioDecision[file=${resolved.mediaFile.id}] tryDirectPlay → audioSupported=${directPlayResult.audioSupported}, containerSupported=${directPlayResult.containerSupported}, videoSupported=${directPlayResult.videoSupported}, reasons=${reasons.map((r) => r.flag).join('|') || '-'}`,
    );

    // HDR on SDR client forces transcode
    if (needsTonemapping) {
      if (directPlayResult.canDirectPlay)
        directPlayResult.canDirectPlay = false;
      reasons.push({
        flag: 'VideoHdrNotSupported',
        message: `HDR → SDR (tone mapping ${source.hdrFormat})`,
      });
    }

    // Subtitle burn-in forces transcode
    if (needsBurnIn) {
      if (directPlayResult.canDirectPlay)
        directPlayResult.canDirectPlay = false;
      reasons.push({
        flag: 'SubtitleBurnIn',
        message: 'Sous-titres gravés dans la vidéo',
      });
    }

    // Crop (black bar removal) forces transcode
    if (needsCrop) {
      if (directPlayResult.canDirectPlay)
        directPlayResult.canDirectPlay = false;
      reasons.push({
        flag: 'VideoCrop',
        message: 'Suppression des bandes noires',
      });
    }

    // --- Quality / engine routing gate ---
    // The full quality ladder is always exposed (see buildQualityList). Direct
    // Play — and remux at source resolution — is only what the client wants
    // when it asks for the source rung. A lower explicit rung routes to the
    // transcode ladder; "Auto" routes there too when the admin picked
    // autoQualityMode='abr'. HLS-only engines (Tizen AVPlay) can never open a
    // raw file, so they skip DirectPlay but still remux to HLS.
    const wantsSourceRung =
      requestedQuality == null ||
      requestedQuality === 'auto' ||
      requestedQuality === 'original';
    const autoOnLadder =
      (requestedQuality == null || requestedQuality === 'auto') &&
      autoQualityMode === 'abr';
    // Lower explicit rung OR ABR-on-auto: skip both DirectPlay and remux so the
    // backend re-encodes at the requested rung (and the master carries the ABR
    // ladder).
    const forceLadder = autoOnLadder || !wantsSourceRung;

    // Whether the source can be served at its own resolution without
    // re-encoding (raw direct play or codec-copy remux). Independent of the
    // quality gate so the `original` rung stays in the menu even while the user
    // is currently watching a lower transcoded rung — letting them switch back.
    const sourceCopyable =
      directPlayResult.videoSupported &&
      directPlayResult.videoConditionsMet &&
      !needsTonemapping &&
      !needsBurnIn &&
      !needsCrop;

    if (profile.supportsDirectPlay === false && directPlayResult.canDirectPlay) {
      directPlayResult.canDirectPlay = false;
      reasons.push({
        flag: 'ClientRequiresHls',
        message: 'Client requires an HLS container (no raw direct play)',
      });
    }
    if (forceLadder) {
      if (directPlayResult.canDirectPlay)
        directPlayResult.canDirectPlay = false;
      // `Video*` prefix so the player stats overlay surfaces it in the video
      // section: a quality-driven transcode is not a defect, the user should
      // see it was their bitrate/quality choice, not an incompatibility.
      reasons.push(
        autoOnLadder
          ? { flag: 'VideoAbr', message: 'Adaptive bitrate (ABR) mode' }
          : {
              flag: 'VideoQualityReduced',
              message: `Reduced-quality rung selected (${requestedQuality})`,
            },
      );
    }

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
        hwAccel: 'none',
        tonemapping: false,
        qualities: this.buildQualityList(source, 'DirectPlay', sourceCopyable, qualityLadder),
        source,
      });
    }

    // --- Step 2: Try DirectStream (remux) ---
    // Video codec must be supported; only container or audio may differ
    // Cannot remux if tone mapping or burn-in is needed (video must be re-encoded).
    // A lower explicit rung / ABR-on-auto wants a re-encoded ladder, not a
    // source-resolution remux copy, so `forceLadder` skips this path too.
    const canCopyVideo = sourceCopyable && !forceLadder;
    if (canCopyVideo) {
      // Some audio codecs the device profile claims to support are
      // only playable in their NATIVE container (e.g. MP3 via
      // `audio/mpeg`), not when wrapped inside fMP4 segments via MSE
      // — Chrome refuses `audio/mp4; codecs="mp4a.6B"` on append.
      // For DirectStream we always emit fMP4 / HLS, so audio codecs
      // outside the fMP4-MSE-safe set get force-transcoded to AAC
      // regardless of the profile match.
      const fmp4CompatibleAudio = new Set(['aac', 'ac3', 'eac3', 'opus', 'flac']);
      const canCopyAudio =
        directPlayResult.audioSupported &&
        fmp4CompatibleAudio.has(sourceAudioCodec.toLowerCase());
      const outputAudioCodec = canCopyAudio ? sourceAudioCodec : 'aac';
      if (!canCopyAudio && !reasons.some((r) => r.flag.startsWith('Audio'))) {
        reasons.push({
          flag: 'AudioCodecNotSupported',
          message: `Audio codec "${sourceAudioCodec}" is not playable inside fMP4 segments`,
        });
      }
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
      for (const p of qualityLadder) {
        const v = parseBitrateToBps(p.videoBitrate);
        const a = parseBitrateToBps(p.audioBitrate);
        transcodeBitrateByQuality[p.name] = {
          videoBitrateBps: v,
          audioBitrateBps: a,
          totalBitrateBps: v + a,
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
        audioPlan: canCopyAudio
          ? { mode: 'copy', codec: sourceAudioCodec }
          : {
              mode: 'transcode',
              codec: 'aac',
              bitrateBps: parseBitrateToBps(ladder[0]?.audioBitrate ?? '192k'),
            },
        outputContainer: 'hls',
        // Report the backend's detected hwAccel even on the remux path:
        // the stats overlay binds this to the active *quality* (remux →
        // "Direct playback" / transcode rung → "Transcoding (<HW>)"). A
        // hard-coded 'none' here surfaced as "Transcoding (CPU)" as soon
        // as the user switched to a transcoded rung (e.g. 1080p-hdr via
        // hevc_qsv main10), since the field is stale for the new session.
        hwAccel: this.transcodingService.getDetectedHwAccel(),
        tonemapping: false,
        remuxMasterBandwidthBps: remuxBw > 0 ? remuxBw : undefined,
        transcodeBitrateByQuality,
        qualities: this.buildQualityList(source, 'DirectStream', sourceCopyable, qualityLadder),
        source,
      });
    }

    // --- Step 3: Full Transcode ---
    if (
      needsTonemapping &&
      !reasons.some((r) => r.flag === 'VideoHdrNotSupported')
    ) {
      reasons.push({
        flag: 'VideoHdrNotSupported',
        message: `HDR → SDR (tone mapping ${source.hdrFormat})`,
      });
    }
    // Mirror the ffmpeg-args dispatch: same pipeline rule, same registry
    // resolve, same qsvCanCrop hint. Picks up the registry's runtime
    // fallback (e.g. h264_vaapi disabled → libx264) so the stats overlay
    // reports the actual encoder that will run, not the host's nominal
    // HW accel.
    const detectedHw = this.transcodingService.getDetectedHwAccel();
    const normalisedSourceCodecForDecode =
      normaliseSourceCodec(sourceVideoCodec);
    const hasUsableQsvNativeDecoderForReport =
      detectedHw === 'qsv' &&
      !needsBurnIn &&
      normalisedSourceCodecForDecode != null &&
      isDecoderEnabled(`${normalisedSourceCodecForDecode}_qsv_native_decode`);
    const qsvNativeAvailableForReport =
      hasUsableQsvNativeDecoderForReport &&
      needsCrop &&
      (!needsTonemapping || isVppQsvTonemapEnabled());
    const qsvCanCropForReport =
      qsvNativeAvailableForReport ||
      (detectedHw === 'qsv' && needsCrop && needsTonemapping && !needsBurnIn);
    const requestedHwAccel = requestedHwAccelFor(detectedHw, {
      burnIn: needsBurnIn,
      crop: needsCrop,
      qsvCanCrop: qsvCanCropForReport,
    });
    const effectiveHwAccel =
      encoderRegistry.resolve(selectedVariant, requestedHwAccel)?.hwAccel ??
      'none';

    // Audio output decision — single source of truth for ffmpeg-args and
    // the master playlist. Three paths:
    //
    //   1. Source codec decodable by the receiver + channels ≤ max →
    //      `audioOutputCodec = source.audioCodec`, `canCopyAudio = true`.
    //      ffmpeg-args runs `-c:a copy` (verbatim bitstream, no priming).
    //   2. Source has ≥ 6 channels + receiver accepts a surround codec →
    //      pick the best (EAC-3 > AC-3) and transcode to it at 640 kbps.
    //      `canCopyAudio = false` — ffmpeg re-encodes preserving channels.
    //   3. Otherwise → AAC stereo downmix at the ladder bitrate.
    const profileAudioCodecs = profile.directPlayProfiles
      .flatMap((p) => p.audioCodecs)
      .map((c) => c.toLowerCase());
    const srcChannels = source.audioChannels ?? 2;
    const maxChannels = profile.maxAudioChannels ?? 2;
    const srcCodec = (source.audioCodec ?? '').toLowerCase();
    const srcCompatible =
      directPlayResult.audioSupported && srcChannels <= maxChannels;
    const surroundPossible =
      srcChannels >= 6 &&
      maxChannels >= 6 &&
      (profileAudioCodecs.includes('eac3') ||
        profileAudioCodecs.includes('ac3'));

    let outputAudioCodec: 'aac' | 'ac3' | 'eac3' | string;
    let outputAudioBitrateBps: number;
    let canCopyAudio = false;

    if (srcCompatible) {
      outputAudioCodec = srcCodec;
      outputAudioBitrateBps = source.audioBitRate ?? 0;
      canCopyAudio = true;
    } else if (surroundPossible) {
      if (profileAudioCodecs.includes('eac3')) outputAudioCodec = 'eac3';
      else outputAudioCodec = 'ac3';
      outputAudioBitrateBps = 640_000;
    } else {
      outputAudioCodec = 'aac';
      outputAudioBitrateBps = parseBitrateToBps(
        ladder[0]?.audioBitrate ?? '192k',
      );
    }

    // When the surround path is what saved us, don't keep claiming the
    // source codec is incompatible — the user actually gets surround.
    if (surroundPossible && !srcCompatible) {
      const idx = reasons.findIndex((r) => r.flag === 'AudioCodecNotSupported');
      if (idx >= 0) reasons.splice(idx, 1);
    }

    this.log.log(
      `Transcode for file ${resolved.mediaFile.id}: ${reasons.map((r) => r.flag).join(', ')} (audioOut=${outputAudioCodec}, copy=${canCopyAudio}, srcCh=${srcChannels}, maxCh=${maxChannels})`,
    );
    const url = `/api/stream/${resolved.mediaFile.id}/master.m3u8${tokenParam}`;
    const transcodeBitrateByQuality: NonNullable<
      PlaybackInfoResponse['transcodeBitrateByQuality']
    > = {};
    // Key by the offered ladder (HDR/eco-hdr rungs carry `-hdr`) so the stats
    // overlay resolves the selected rung instead of falling back to the full
    // remux bandwidth.
    for (const p of qualityLadder) {
      const v = parseBitrateToBps(p.videoBitrate);
      const a = outputAudioBitrateBps ?? parseBitrateToBps(p.audioBitrate);
      transcodeBitrateByQuality[p.name] = {
        videoBitrateBps: v,
        audioBitrateBps: a,
        totalBitrateBps: v + a,
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
      outputVideoCodec: 'h264',
      outputAudioCodec,
      audioPlan: canCopyAudio
        ? { mode: 'copy', codec: srcCodec }
        : {
            mode: 'transcode',
            codec: outputAudioCodec as 'aac' | 'ac3' | 'eac3',
            bitrateBps: outputAudioBitrateBps,
          },
      outputContainer: 'hls',
      hwAccel: effectiveHwAccel,
      tonemapping: needsTonemapping,
      transcodeBitrateByQuality,
      qualities: this.buildQualityList(source, 'Transcode', sourceCopyable, qualityLadder),
      source,
    });
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
    const totalOf = (p: TranscodeProfile) =>
      parseBitrateToBps(p.videoBitrate) + parseBitrateToBps(p.audioBitrate);

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
    // 720p eco…). Same on every device. Only listed when genuinely lighter
    // than the source — no point offering an eco rung heavier than the file.
    const savingRef = sourceTotal > 0 ? sourceTotal : totalOf(topProfile);
    for (const p of available) {
      if (!isEcoProfile(p.name) || totalOf(p) >= savingRef) continue;
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

    // Check against each DirectPlayProfile
    for (const dp of profile.directPlayProfiles) {
      if (dp.containers.includes(source.container)) containerSupported = true;
      if (dp.videoCodecs.includes(source.videoCodec)) videoSupported = true;
      if (dp.audioCodecs.includes(source.audioCodec)) audioSupported = true;
    }

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
            message: `Niveau ${source.videoLevel} > max ${cond.maxLevel}`,
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
        if (cond.maxWidth && source.width && source.width > cond.maxWidth) {
          videoConditionsMet = false;
          reasons.push({
            flag: 'VideoResolutionNotSupported',
            message: `Largeur ${source.width} > max ${cond.maxWidth}`,
          });
        }
        if (cond.maxHeight && source.height && source.height > cond.maxHeight) {
          videoConditionsMet = false;
          reasons.push({
            flag: 'VideoResolutionNotSupported',
            message: `Hauteur ${source.height} > max ${cond.maxHeight}`,
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
          message: `Débit trop élevé (${Math.round(totalBitrate / 1_000_000)} Mbps)`,
        });
        videoConditionsMet = false;
      }
    }

    // Audio channels check
    if (
      profile.maxAudioChannels &&
      source.audioChannels &&
      source.audioChannels > profile.maxAudioChannels
    ) {
      audioSupported = false;
      reasons.push({
        flag: 'AudioChannelsNotSupported',
        message: `${source.audioChannels} canaux > max ${profile.maxAudioChannels}`,
      });
    }

    if (!videoSupported) {
      reasons.push({
        flag: 'VideoCodecNotSupported',
        message: `Codec "${source.videoCodec}" not supported`,
      });
    }
    if (!audioSupported) {
      reasons.push({
        flag: 'AudioCodecNotSupported',
        message: `Codec "${source.audioCodec}" not supported`,
      });
    }
    if (!containerSupported) {
      reasons.push({
        flag: 'ContainerNotSupported',
        message: `Conteneur "${source.container}" not supported`,
      });
    }

    const canDirectPlay =
      containerSupported &&
      videoSupported &&
      audioSupported &&
      videoConditionsMet;
    return {
      canDirectPlay,
      containerSupported,
      videoSupported,
      audioSupported,
      videoConditionsMet,
    };
  }
}
