import { Injectable, Logger } from '@nestjs/common';
import { DeviceProfileDto } from './dto/device-profile.dto';
import {
  PlaybackInfoResponse,
  TranscodeReason,
} from './dto/playback-info.dto';
import { ResolvedFile } from './streaming.service';
import { TranscodingService } from './transcoding.service';

/**
 * Decides how a media file should be played: DirectPlay, DirectStream (remux), or Transcode.
 *
 * Decision tree (inspired by Jellyfin's StreamBuilder):
 * 1. If container + video codec + audio codec all match a DirectPlayProfile
 *    AND all codec conditions pass → DirectPlay
 * 2. If only container or audio fails (video is compatible) → DirectStream (remux)
 *    Video stream is copied, container is changed, audio may be transcoded
 * 3. Otherwise → full Transcode (video re-encoded via HLS)
 */
@Injectable()
export class StreamBuilderService {
  private readonly log = new Logger(StreamBuilderService.name);

  constructor(private readonly transcodingService: TranscodingService) {}

  /**
   * Evaluate a media file against a device profile and return the playback decision.
   */
  evaluate(
    resolved: ResolvedFile,
    profile: DeviceProfileDto,
    tokenParam: string,
  ): PlaybackInfoResponse {
    const si = resolved.mediaFile.streamInfo as any;
    const v = si?.video?.[0];
    const a = si?.audio?.[0];

    const sourceContainer = resolved.ext.replace('.', '').toLowerCase();
    const sourceVideoCodec = (v?.codec ?? '').toLowerCase();
    const sourceAudioCodec = (a?.codec ?? '').toLowerCase();

    const source = {
      container: sourceContainer,
      videoCodec: sourceVideoCodec,
      videoProfile: v?.profile?.toLowerCase(),
      videoLevel: v?.level,
      videoBitRate: v?.bitRate,
      videoBitDepth: v?.bitDepth,
      width: v?.width,
      height: v?.height,
      frameRate: v?.frameRate,
      audioCodec: sourceAudioCodec,
      audioChannels: a?.channels,
      audioChannelLayout: a?.channelLayout,
      audioBitRate: a?.bitRate,
      audioSampleRate: a?.sampleRate,
      audioLanguage: a?.language,
      durationSeconds: si?.durationSeconds,
    };

    const reasons: TranscodeReason[] = [];

    // --- Step 1: Try DirectPlay ---
    const directPlayResult = this.tryDirectPlay(source, profile, reasons);
    if (directPlayResult.canDirectPlay) {
      this.log.log(`DirectPlay for file ${resolved.mediaFile.id}: ${sourceContainer}/${sourceVideoCodec}/${sourceAudioCodec}`);
      const url = `/api/stream/${resolved.mediaFile.id}${tokenParam}`;
      return {
        mediaFileId: resolved.mediaFile.id,
        playMethod: 'DirectPlay',
        playUrl: url,
        contentType: resolved.contentType,
        transcodeReasons: [],
        videoCopyStream: true,
        audioCopyStream: true,
        outputVideoCodec: sourceVideoCodec,
        outputAudioCodec: sourceAudioCodec,
        outputContainer: sourceContainer,
        hwAccel: 'none',
        source,
      };
    }

    // --- Step 2: Try DirectStream (remux) ---
    // Video codec must be supported; only container or audio may differ
    const canCopyVideo = directPlayResult.videoSupported && directPlayResult.videoConditionsMet;
    if (canCopyVideo) {
      const canCopyAudio = directPlayResult.audioSupported;
      const outputAudioCodec = canCopyAudio ? sourceAudioCodec : 'aac';
      if (!canCopyAudio) {
        reasons.push({ flag: 'AudioCodecNotSupported', message: `Audio codec "${sourceAudioCodec}" not supported, transcoding to AAC` });
      }
      if (!directPlayResult.containerSupported) {
        reasons.push({ flag: 'ContainerNotSupported', message: `Container "${sourceContainer}" not supported, remuxing to HLS` });
      }

      this.log.log(`DirectStream (remux) for file ${resolved.mediaFile.id}: copy video, ${canCopyAudio ? 'copy' : 'transcode'} audio`);
      const sep = tokenParam ? '&' : '?';
      const url = `/api/stream/${resolved.mediaFile.id}/master.m3u8${tokenParam}${sep}remux=1`;
      return {
        mediaFileId: resolved.mediaFile.id,
        playMethod: 'DirectStream',
        playUrl: url,
        contentType: 'application/vnd.apple.mpegurl',
        transcodeReasons: reasons,
        videoCopyStream: true,
        audioCopyStream: canCopyAudio,
        outputVideoCodec: sourceVideoCodec,
        outputAudioCodec,
        outputContainer: 'hls',
        hwAccel: canCopyAudio ? 'none' : this.transcodingService.getDetectedHwAccel(),
        source,
      };
    }

    // --- Step 3: Full Transcode ---
    this.log.log(`Transcode for file ${resolved.mediaFile.id}: ${reasons.map(r => r.flag).join(', ')}`);
    const url = `/api/stream/${resolved.mediaFile.id}/master.m3u8${tokenParam}`;
    return {
      mediaFileId: resolved.mediaFile.id,
      playMethod: 'Transcode',
      playUrl: url,
      contentType: 'application/vnd.apple.mpegurl',
      transcodeReasons: reasons,
      videoCopyStream: false,
      audioCopyStream: false,
      outputVideoCodec: 'h264',
      outputAudioCodec: 'aac',
      outputContainer: 'hls',
      hwAccel: this.transcodingService.getDetectedHwAccel(),
      source,
    };
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
      const cond = profile.codecConditions.find(c => c.codec === source.videoCodec);
      if (cond) {
        if (cond.maxLevel && source.videoLevel && source.videoLevel > cond.maxLevel) {
          videoConditionsMet = false;
          reasons.push({ flag: 'VideoLevelNotSupported', message: `Video level ${source.videoLevel} exceeds max ${cond.maxLevel}` });
        }
        if (cond.profiles?.length && source.videoProfile && !cond.profiles.includes(source.videoProfile)) {
          videoConditionsMet = false;
          reasons.push({ flag: 'VideoProfileNotSupported', message: `Video profile "${source.videoProfile}" not in [${cond.profiles.join(',')}]` });
        }
        if (cond.maxBitDepth && source.videoBitDepth && source.videoBitDepth > cond.maxBitDepth) {
          videoConditionsMet = false;
          reasons.push({ flag: 'VideoBitDepthNotSupported', message: `Bit depth ${source.videoBitDepth} exceeds max ${cond.maxBitDepth}` });
        }
        if (cond.maxWidth && source.width && source.width > cond.maxWidth) {
          videoConditionsMet = false;
          reasons.push({ flag: 'VideoResolutionNotSupported', message: `Width ${source.width} exceeds max ${cond.maxWidth}` });
        }
        if (cond.maxHeight && source.height && source.height > cond.maxHeight) {
          videoConditionsMet = false;
          reasons.push({ flag: 'VideoResolutionNotSupported', message: `Height ${source.height} exceeds max ${cond.maxHeight}` });
        }
      }
    }

    // Bitrate check
    if (profile.maxStreamingBitrate && profile.maxStreamingBitrate > 0) {
      const totalBitrate = (source.videoBitRate ?? 0) + (source.audioBitRate ?? 0);
      if (totalBitrate > profile.maxStreamingBitrate) {
        reasons.push({ flag: 'VideoBitrateNotSupported', message: `Bitrate ${totalBitrate} exceeds max ${profile.maxStreamingBitrate}` });
        videoConditionsMet = false;
      }
    }

    // Audio channels check
    if (profile.maxAudioChannels && source.audioChannels && source.audioChannels > profile.maxAudioChannels) {
      audioSupported = false;
      reasons.push({ flag: 'AudioChannelsNotSupported', message: `${source.audioChannels} channels exceeds max ${profile.maxAudioChannels}` });
    }

    if (!videoSupported) {
      reasons.push({ flag: 'VideoCodecNotSupported', message: `Video codec "${source.videoCodec}" not supported by client` });
    }
    if (!audioSupported) {
      reasons.push({ flag: 'AudioCodecNotSupported', message: `Audio codec "${source.audioCodec}" not supported by client` });
    }
    if (!containerSupported) {
      reasons.push({ flag: 'ContainerNotSupported', message: `Container "${source.container}" not supported by client` });
    }

    const canDirectPlay = containerSupported && videoSupported && audioSupported && videoConditionsMet;
    return { canDirectPlay, containerSupported, videoSupported, audioSupported, videoConditionsMet };
  }
}
