import {
  getHdrLadderForDevice,
  getLadderForDevice,
  parseBitrateToBps,
} from './profiles';
import type { DeviceType, TranscodeProfile } from './types';

/**
 * Get available quality profiles for a given source resolution + device class.
 */
export function getAvailableProfiles(
  sourceWidth: number,
  sourceHeight: number,
  deviceType: DeviceType = 'desktop',
): TranscodeProfile[] {
  return getLadderForDevice(deviceType).filter(
    (p) => p.maxWidth <= sourceWidth || p.maxHeight <= sourceHeight,
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
        defaultAudioIndex >= 0 && defaultAudioIndex < audioStreams!.length
          ? defaultAudioIndex
          : 0;
      for (let i = 0; i < audioStreams!.length; i++) {
        const a = audioStreams![i];
        const lang = a.language || 'und';
        const name = a.title || lang;
        const isDefault = i === pickedIdx ? 'YES' : 'NO';
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",LANGUAGE="${lang}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},URI="/api/stream/${mediaFileId}/audio/${i}/index.m3u8${tokenParam}"`,
        );
      }
    }
    const hdrAudioAttr = multiAudio ? ',AUDIO="audio"' : '';

    // Top rung: remux (-c:v copy) at source resolution. Zero re-encode
    // cost, perfect quality, native HDR. Always present.
    {
      const topVideoCodec = hevcMain10CodecStringForHeight(sourceHeight);
      const v = hdrPassThrough.videoBitRateBps ?? sourceBitrate ?? 0;
      const a = hdrPassThrough.audioBitRateBps ?? 0;
      const avg = v + a;
      const bw = Math.round(avg * 1.1);
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${avg},RESOLUTION=${sourceWidth}x${sourceHeight},VIDEO-RANGE=${range},NAME="original-hdr",CODECS="${topVideoCodec},${audioCodec}"${hdrAudioAttr}`,
        `/api/stream/${mediaFileId}/remux/index.m3u8${tokenParam}`,
      );
    }

    // Lower-resolution HEVC HDR transcode rungs. Filter to those strictly
    // below the source — emitting a transcode rung at source resolution
    // would duplicate the remux rung above with worse quality.
    const hdrLadder = getHdrLadderForDevice(deviceType).filter(
      (p) => p.maxHeight < sourceHeight,
    );
    for (const p of hdrLadder) {
      const avg =
        parseBitrateToBps(p.videoBitrate) + parseBitrateToBps(p.audioBitrate);
      const bw = Math.round(avg * 1.5);
      const w = Math.min(p.maxWidth, sourceWidth);
      const rawH = (w * sourceHeight) / sourceWidth;
      const h = Math.floor(rawH / 16) * 16 || 16;
      const videoCodec = hevcMain10CodecStringForHeight(p.maxHeight);
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${avg},RESOLUTION=${w}x${h},VIDEO-RANGE=${range},NAME="${p.name}",CODECS="${videoCodec},${audioCodec}"${hdrAudioAttr}`,
        `/api/stream/${mediaFileId}/${p.name}/index.m3u8${tokenParam}`,
      );
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

  if (onlyQuality) {
    if (onlyQuality === 'remux' || onlyQuality === 'original') {
      // Pick the top profile whose maxWidth is ≤ source (matches source
      // resolution as closely as possible without upscaling).
      const top =
        profiles.find((p) => p.maxWidth <= sourceWidth) ?? profiles[0];
      profiles = [top];
    } else {
      const picked = profiles.find((p) => p.name === onlyQuality);
      if (picked) profiles = [picked];
    }
  }

  for (const p of profiles) {
    const avg =
      parseBitrateToBps(p.videoBitrate) + parseBitrateToBps(p.audioBitrate);
    // BANDWIDTH must reflect the peak segment bitrate (HLS spec). With
    // `-maxrate == -b:v` the encoder is near-CBR but VBV bursts still
    // push individual segments ~30% above nominal. Declaring BANDWIDTH
    // ~1.5× nominal gives AVPlayer ABR a stable hysteresis margin and
    // stops it from down-/up-shifting on every VBV spike.
    const bw = Math.round(avg * 1.5);
    const w = Math.min(p.maxWidth, sourceWidth);
    const rawH = (w * sourceHeight) / sourceWidth;
    const h = Math.floor(rawH / 16) * 16 || 16;
    const videoCodec = h264CodecStringForHeight(p.maxHeight);
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
  if (height >= 720)  return 'hvc1.2.4.L120.B0'; // L4.0 — 720p60
  return 'hvc1.2.4.L93.B0';                       // L3.1 — up to 720p30
}

/** H.264 codec string per rung. Levels picked to cover 60 fps at the rung
 *  resolution, so the actual encoder output never signals a higher level
 *  than the master playlist advertises (which would force iOS AVPlayer to
 *  reinitialise the decoder mid-stream → frame freeze). */
function h264CodecStringForHeight(height: number): string {
  if (height >= 2160) return 'avc1.640034'; // High @ L5.2 — 4K60
  if (height >= 1080) return 'avc1.64002a'; // High @ L4.2 — 1080p60 + headroom
  if (height >= 720)  return 'avc1.640020'; // High @ L3.2 — 720p60
  if (height >= 480)  return 'avc1.64001f'; // High @ L3.1 — 480p60
  if (height >= 360)  return 'avc1.64001e'; // High @ L3.0 — 360p30
  if (height >= 240)  return 'avc1.640015'; // High @ L2.1 — 240p60
  return 'avc1.64000d';                      // High @ L1.3 — 144p
}
