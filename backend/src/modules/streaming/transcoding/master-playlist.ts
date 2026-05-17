import {
  getHdrLadderForDevice,
  getLadderForDevice,
  parseBitrateToBps,
  profileFitsSource,
  profileResolution,
} from './profiles';
import type { DeviceType, TranscodeProfile } from './types';
import type { CodecVariant } from './codec/types';
import { h264CodecString, hevcMainCodecString } from './codec/codec-strings';

/** Apply the `onlyQuality` URL pin to a ladder. Used identically by
 *  the SDR and HDR branches: when the player has a saved quality
 *  preference (or an explicit dropdown pick), the master playlist
 *  emits a single-variant ladder so ExoPlayer's HLS source can't
 *  pre-load other variants — each unfocused variant playlist or
 *  init.mp4 fetch triggers a ffmpeg kill+respawn on the backend
 *  when the requested quality doesn't match the active session.
 *
 *  - `remux` / `original` collapse to the top SDR profile that fits
 *    the source resolution (no upscale). HDR ladder ignores these
 *    pseudo-labels because the source-resolution HDR rung is emitted
 *    via the separate `hdrPassThrough` block.
 *  - When `hdrSuffix` is true, an input `1080p` is matched against
 *    `1080p-hdr` (HDR ladder rungs carry the suffix); already
 *    `*-hdr` inputs pass through unchanged.
 *  - Falls back to the full ladder when the pin doesn't match any
 *    rung (legacy URLs / typos). */
function applyQualityPin(
  ladder: TranscodeProfile[],
  onlyQuality: string | undefined,
  sourceWidth: number,
  hdrSuffix = false,
): TranscodeProfile[] {
  if (!onlyQuality) return ladder;
  if (onlyQuality === 'remux' || onlyQuality === 'original') {
    if (hdrSuffix) return ladder;
    const top = ladder.find((p) => p.maxWidth <= sourceWidth) ?? ladder[0];
    return [top];
  }
  const wanted =
    hdrSuffix && !onlyQuality.endsWith('-hdr')
      ? `${onlyQuality}-hdr`
      : onlyQuality;
  const picked = ladder.find((p) => p.name === wanted);
  return picked ? [picked] : ladder;
}

/**
 * Get available quality profiles for a given source resolution + device class.
 */
export function getAvailableProfiles(
  sourceWidth: number,
  sourceHeight: number,
  deviceType: DeviceType = 'desktop',
): TranscodeProfile[] {
  return getLadderForDevice(deviceType).filter((p) =>
    profileFitsSource(p, sourceWidth, sourceHeight),
  );
}

/**
 * Generate the HLS master playlist listing available qualities.
 */
export function generateMasterPlaylist(
  mediaFileId: number,
  sourceWidth: number,
  sourceHeight: number,
  tokenParam: string,
  includeRemux = false,
  sourceBitrate?: number,
  audioStreams?: { language?: string; title?: string }[],
  onlyQuality?: string,
  defaultAudioIndex = 0,
  deviceType: DeviceType = 'desktop',
  /** Output audio codec actually emitted by ffmpeg. The CODECS attribute
   *  must match or the receiver rejects the segment at MSE chunk-demuxer
   *  append. Recognised values: `'aac'` (AAC-LC), `'ac3'` (Dolby Digital),
   *  `'eac3'` (Dolby Digital Plus). Defaults to AAC for legacy callers. */
  outputAudioCodec: 'aac' | 'ac3' | 'eac3' = 'aac',
  /** When set, the master advertises a single HEVC HDR variant pointing at
   *  the `remux/index.m3u8` path instead of the H.264 transcode ladder.
   *  The remux session does `-c:v copy` so the HDR metadata (BT.2020/PQ
   *  or HLG transfer) reaches the player intact. iOS AVPlayer / ExoPlayer
   *  use the `VIDEO-RANGE` attribute + `hvc1.*` codec string to dispatch
   *  to the HDR rendering path. */
  hdrPassThrough?: {
    hdrFormat: 'HDR10' | 'HLG';
    videoBitRateBps?: number;
    audioBitRateBps?: number;
  },
  /** True when the backend can actually emit HEVC Main10 segments — only
   *  the QSV path has `hevc_qsv Main10` wired (ffmpeg-args.ts). Other
   *  hwAccels (VAAPI, NVENC, VideoToolbox, CPU) fall through to libx264
   *  and produce H.264 segments that contradict the master's `hvc1.*`
   *  CODECS string, which trips a Media3 fallback-options crash on
   *  ExoPlayer. When false, only the remux pass-through rung is emitted
   *  — that path is `-c:v copy` and works regardless of hwAccel. */
  canEncodeHevcHdr = false,
  /** SDR-ladder output codec, picked by the codec selector. When the
   *  selector promoted HEVC (source codec match, or efficiency
   *  ranking on HEVC-capable clients), every SDR rung emits a
   *  `hvc1.*` CODECS string instead of `avc1.*` so MSE doesn't reject
   *  the appended segments. Absent for legacy callers that haven't
   *  threaded the variant through — falls back to H.264 codec strings. */
  sdrVariant?: CodecVariant,
): string {
  const multiAudio = audioStreams && audioStreams.length > 1;
  const lines = ['#EXTM3U'];

  const audioCodecMap = { aac: 'mp4a.40.2', ac3: 'ac-3', eac3: 'ec-3' };
  const audioCodec = audioCodecMap[outputAudioCodec] ?? 'mp4a.40.2';

  // HDR pass-through path — emitted when the source is HEVC HDR and
  // the client claims HDR support. Outputs a full HEVC HDR ladder
  // (one remux rung at source resolution + HEVC HDR transcode rungs
  // below) so the user can switch resolution while keeping HDR
  // signaling (BT.2020/PQ or HLG). The H.264 SDR ladder is omitted in
  // this branch — mixing SDR and HDR rungs in one master playlist
  // confuses AVPlayer's ABR and triggers display-mode flips. Clients
  // that want SDR explicitly disable HDR client-side (which flips
  // `clientSupportsHdr` to false and re-routes to the SDR ladder).
  if (hdrPassThrough) {
    const range = hdrPassThrough.hdrFormat === 'HLG' ? 'HLG' : 'PQ';

    // Multi-audio: each HEVC HDR variant references the shared audio
    // group via AUDIO="audio". Audio is served from /audio/<i>/ as
    // standalone AAC renditions, same wiring as the SDR ladder.
    if (multiAudio) {
      const pickedIdx =
        defaultAudioIndex >= 0 && defaultAudioIndex < audioStreams.length
          ? defaultAudioIndex
          : 0;
      for (let i = 0; i < audioStreams.length; i++) {
        const a = audioStreams[i];
        const lang = a.language || 'und';
        const name = a.title || lang;
        const isDefault = i === pickedIdx ? 'YES' : 'NO';
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",LANGUAGE="${lang}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},URI="/api/stream/${mediaFileId}/audio/${i}/index.m3u8${tokenParam}"`,
        );
      }
    }
    const hdrAudioAttr = multiAudio ? ',AUDIO="audio"' : '';

    // HEVC HDR rungs are pure transcodes (hevc_qsv Main10 with forced
    // 3-second keyframes), gated on `canEncodeHevcHdr`. The former
    // top "remux" pass-through was dropped: `-c:v copy` cuts on
    // existing source IDRs (variable durations) which mis-aligns with
    // the synthetic uniform-3s VOD playlist, and ExoPlayer's buffer
    // scheduler drifts behind audio. A transcode at ~28 Mbps Main10
    // is visually transparent and gives perfectly uniform segments.
    // Includes the source-resolution rung if there's an HDR profile
    // at or below source height.
    if (canEncodeHevcHdr) {
      const hdrLadder = applyQualityPin(
        getHdrLadderForDevice(deviceType).filter((p) =>
          profileFitsSource(p, sourceWidth, sourceHeight),
        ),
        onlyQuality,
        sourceWidth,
        /* hdrSuffix */ true,
      );
      for (const p of hdrLadder) {
        const avg =
          parseBitrateToBps(p.videoBitrate) + parseBitrateToBps(p.audioBitrate);
        const bw = Math.round(avg * 1.5);
        const { width: w, height: h } = profileResolution(
          p,
          sourceWidth,
          sourceHeight,
        );
        // Use actual emitted height for the codec level — see SDR
        // branch below for the rationale (Arcane / cropped sources).
        const videoCodec = hevcMain10CodecStringForHeight(h);
        lines.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${avg},RESOLUTION=${w}x${h},VIDEO-RANGE=${range},NAME="${p.name}",CODECS="${videoCodec},${audioCodec}"${hdrAudioAttr}`,
          `/api/stream/${mediaFileId}/${p.name}/index.m3u8${tokenParam}`,
        );
      }
    }
    return lines.join('\n');
  }

  // Multi-audio: declare alternate audio renditions via EXT-X-MEDIA
  if (multiAudio) {
    const pickedIdx =
      defaultAudioIndex >= 0 && defaultAudioIndex < audioStreams.length
        ? defaultAudioIndex
        : 0;
    for (let i = 0; i < audioStreams.length; i++) {
      const a = audioStreams[i];
      const lang = a.language || 'und';
      const name = a.title || lang;
      const isDefault = i === pickedIdx ? 'YES' : 'NO';
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",LANGUAGE="${lang}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},URI="/api/stream/${mediaFileId}/audio/${i}/index.m3u8${tokenParam}"`,
      );
    }
  }

  // Always declare CODECS on EXT-X-STREAM-INF. For HLS-TS, this lets Shaka
  // skip fetching seg 0 purely to probe codecs (TS has no init segment) —
  // otherwise a user resuming mid-file wastes a transcode pass at seg 0
  // before the real seek-aware session starts at their resume position.
  // Video codec string is per-rung: H.264 High profile with a level high
  // enough for the rung's resolution at 60 fps. A single `avc1.640028`
  // (L4.0) for every rung makes iOS AVPlayer reject 4K segments whose
  // bitstream signals L5.x — visible as decoder reinit / frame freeze.
  const audioAttr = multiAudio ? ',AUDIO="audio"' : '';

  // The HLS master never advertises the `/remux/` variant — it proved
  // unreliable on ExoPlayer (Android), which would ABR-downgrade from the
  // remux rung to the identical-resolution 1080p transcode mid-stream and
  // trigger a pointless FFmpeg kill+restart. Transcode profiles cover the
  // full resolution ladder; "remux"/"original" quality picks are mapped
  // onto the top transcode profile.
  const ladder = getLadderForDevice(deviceType);
  let profiles = getAvailableProfiles(sourceWidth, sourceHeight, deviceType);
  if (!profiles.length) profiles.push(ladder[ladder.length - 1]); // at least 480p
  profiles = applyQualityPin(profiles, onlyQuality, sourceWidth);

  for (const p of profiles) {
    const avg =
      parseBitrateToBps(p.videoBitrate) + parseBitrateToBps(p.audioBitrate);
    // BANDWIDTH must reflect the peak segment bitrate (HLS spec). With
    // `-maxrate == -b:v` the encoder is near-CBR but VBV bursts still
    // push individual segments ~30% above nominal. Declaring BANDWIDTH
    // ~1.5× nominal gives AVPlayer ABR a stable hysteresis margin and
    // stops it from down-/up-shifting on every VBV spike.
    const bw = Math.round(avg * 1.5);
    const { width: w, height: h } = profileResolution(
      p,
      sourceWidth,
      sourceHeight,
    );
    // Codec string MUST be derived from the actual emitted height (`h`),
    // not `p.maxHeight`. Cropped content (e.g. 2.39:1 cinemascope on a
    // 1920×1080 source → 1920×816) advertises a height below the
    // profile nominal, so `h264CodecString({height: 720})` would
    // declare avc1 L3.2 in the master while the bitstream SPS carries
    // L3.1 for the actual 1280×544 frames. The mismatch (declared > SPS)
    // can leave ExoPlayer's track selector stuck on cold prepare —
    // visible as the Arcane "buffering forever, no decoder allocated"
    // pattern on Android.
    const target = {
      width: w,
      height: h,
      videoBitrateBps: 0,
      gopSize: 0,
      frameRate: 24,
    };
    const videoCodec =
      sdrVariant?.codec === 'hevc'
        ? hevcMainCodecString(target)
        : h264CodecString(target);
    const codecsAttr = `,CODECS="${videoCodec},${audioCodec}"`;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${avg},RESOLUTION=${w}x${h},NAME="${p.name}"${codecsAttr}${audioAttr}`,
      `/api/stream/${mediaFileId}/${p.name}/index.m3u8${tokenParam}`,
    );
  }
  return lines.join('\n');
}

/** HEVC Main10 codec string for an HDR pass-through variant. Format:
 *  `hvc1.{profile_space}.{profile_idc}{compat}.L{level_idc}.{constraints}`.
 *  Profile_space=2, profile_idc=4 = Main10 (the only HEVC profile with
 *  10-bit support, which HDR10 / HLG require). Levels picked to cover
 *  60 fps at the rung resolution so AVPlayer doesn't reject the variant
 *  on a level mismatch with the actual SPS. */
function hevcMain10CodecStringForHeight(height: number): string {
  if (height >= 2160) return 'hvc1.2.4.L153.B0'; // L5.1 — 4K60
  if (height >= 1080) return 'hvc1.2.4.L123.B0'; // L4.1 — 1080p60
  if (height >= 720) return 'hvc1.2.4.L120.B0'; // L4.0 — 720p60
  return 'hvc1.2.4.L93.B0'; // L3.1 — up to 720p30
}
