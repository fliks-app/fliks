import { Component, input, output } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';

export interface PlayerStats {
  container: string;
  containerBitrate: string;
  outputFormat: string;
  outputFps: string;
  /** Translation key for what the server does with the file: direct play, remux or transcode, read from the real delivery; empty when unknown (offline). */
  streamTypeKey: string;
  /** Translated "Server decision: X / Delivered: Y" line, set only when they
   *  disagree. Empty otherwise. */
  mismatch?: string;
  /** `transcodeReasons` flags that are neither video- nor audio-specific:
   *  why DirectStream/DirectPlay wasn't used at all. Absent on live playback. */
  streamTranscodeReasons?: string[];

  videoLabel: string;
  videoStreamBitrate: string;
  videoProfileLine: string;
  videoPlaybackMode: string;
  /** Detected letterbox crop rectangle (`"WxH (offset X,Y)"`) when
   *  the source was flagged by cropdetect. Empty when no crop. */
  crop: string;
  /** True when this client removed the bars (copy delivery); false when the
   *  server did (re-encode). Meaningless when `crop` is empty. Defaults false. */
  cropAppliedByPlayer?: boolean;
  /** Player crop not painting: PiP and iOS native fullscreen show the full frame. Defaults false. */
  cropBypassed?: boolean;
  /** HDR to SDR tone-mapping filter the backend picked (after `auto` resolution and opencl-probe fallback); empty when none runs. */
  tonemapping: string;
  /** `transcodeReasons` driving the video re-encode (`Video*` flags plus `SubtitleBurnIn`); empty when copied; container-level flags are excluded. */
  videoTranscodeReasons: string[];
  droppedFrames: number;

  /** False when the source carries no audio stream (section hidden). Defaults true. */
  hasAudio?: boolean;
  audioLabel: string;
  audioStreamBitrate: string;
  audioDetailLine: string;
  audioPlaybackMode: string;
  /** `transcodeReasons` flags that drive the audio re-encode (any
   *  `Audio*` flag). Empty when the audio stream is copied. */
  audioTranscodeReasons: string[];

  /** Live only: facts an on-demand stream has no equivalent for. */
  live?: {
    behindLive: string;
    rewindWindow: string;
    segmentDuration: string;
  };
}

@Component({
  selector: 'app-player-stats-overlay',
  imports: [UpperCasePipe, TranslatePipe],
  templateUrl: './player-stats-overlay.html',
})
export class PlayerStatsOverlayComponent {
  readonly visible = input(false);
  readonly stats = input<PlayerStats | null>(null);
  readonly close = output<void>();
}
