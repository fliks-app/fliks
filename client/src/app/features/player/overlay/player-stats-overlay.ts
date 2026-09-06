import { Component, input, output } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';

export interface PlayerStats {
  container: string;
  containerBitrate: string;
  outputFormat: string;
  outputFps: string;
  /** Translation key naming what the server actually does with the file:
   *  direct play (served as-is), remux (streams copied into HLS) or transcode
   *  (video re-encoded). Read from the real delivery, not just the decision. */
  streamTypeKey: string;

  videoLabel: string;
  videoStreamBitrate: string;
  videoProfileLine: string;
  videoPlaybackMode: string;
  /** Detected letterbox crop rectangle (`"WxH (offset X,Y)"`) when
   *  the source was flagged by cropdetect. Empty when no crop. */
  crop: string;
  /** HDR → SDR tone-mapping filter the backend actually picked
   *  (after `auto` resolution + opencl-probe fallback). Empty when no
   *  tone-mapping pass runs on this session. */
  tonemapping: string;
  /** `transcodeReasons` flags that drive the video re-encode (any
   *  `Video*` flag plus `SubtitleBurnIn`). Empty when the video
   *  stream is copied. Container-level flags are excluded — they
   *  appear in the stream section, not here. */
  videoTranscodeReasons: string[];
  droppedFrames: number;

  audioLabel: string;
  audioStreamBitrate: string;
  audioDetailLine: string;
  audioPlaybackMode: string;
  /** `transcodeReasons` flags that drive the audio re-encode (any
   *  `Audio*` flag). Empty when the audio stream is copied. */
  audioTranscodeReasons: string[];
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
