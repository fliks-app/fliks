import { getLadderForDevice, parseBitrateToBps } from './profiles';
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
  /** True when the active transcode preserves surround channels via the
   *  `copyAudio` branch in ffmpeg-args (output codec = AC-3 5.1). The
   *  advertised CODECS string must match the actual stream codec or the
   *  receiver rejects the segment at MSE chunk-demuxer append. */
  canCopyAudio = false,
): string {
  const multiAudio = audioStreams && audioStreams.length > 1;
  const lines = ['#EXTM3U'];

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
  // Video is always H.264 High @ L4.0. Audio is AAC-LC by default, or
  // AC-3 ("ac-3") when the transcode is preserving surround.
  const audioAttr = multiAudio ? ',AUDIO="audio"' : '';
  const audioCodec = canCopyAudio ? 'ac-3' : 'mp4a.40.2';
  const transcodeCodecs = `,CODECS="avc1.640028,${audioCodec}"`;

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
    const bw =
      parseBitrateToBps(p.videoBitrate) + parseBitrateToBps(p.audioBitrate);
    const w = Math.min(p.maxWidth, sourceWidth);
    const rawH = (w * sourceHeight) / sourceWidth;
    const h = Math.floor(rawH / 16) * 16 || 16;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h},NAME="${p.name}"${transcodeCodecs}${audioAttr}`,
      `/api/stream/${mediaFileId}/${p.name}/index.m3u8${tokenParam}`,
    );
  }
  return lines.join('\n');
}
