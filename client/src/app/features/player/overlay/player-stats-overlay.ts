import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { UpperCasePipe } from '@angular/common';

export interface PlayerStats {
  container: string;
  containerBitrate: string;
  outputFormat: string;
  outputFps: string;

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
  imports: [UpperCasePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="absolute z-50 bg-black/85 text-white select-none backdrop-blur-sm shadow-2xl overflow-y-auto
                  bottom-20 left-4 text-sm p-5 rounded-xl min-w-[320px] max-w-md max-h-[60vh]
                  max-sm:bottom-0 max-sm:left-0 max-sm:right-0 max-sm:text-xs max-sm:p-3 max-sm:rounded-none max-sm:min-w-0 max-sm:max-w-none max-sm:max-h-[50vh]">

        <button
          class="absolute top-2 right-2 text-white/60 hover:text-white text-lg leading-none cursor-pointer sm:top-3 sm:right-3"
          (click)="close.emit()"
        >&times;</button>

        @if (stats(); as s) {
          <section class="mb-3 sm:mb-4">
            <div class="font-bold text-white/90 mb-0.5 text-xs sm:text-sm">Stream</div>
            <div class="text-white/80 pl-2 space-y-0.5">
              <div class="font-semibold">{{ s.container | uppercase }} ({{ s.containerBitrate }})</div>
              @if (s.outputFormat) {
                <div class="text-white/60">&rarr; {{ s.outputFormat | uppercase }}@if (s.outputFps) { ({{ s.outputFps }}) }</div>
              }
            </div>
          </section>

          <section class="mb-3 sm:mb-4">
            <div class="font-bold text-white/90 mb-0.5 text-xs sm:text-sm">Video</div>
            <div class="text-white/80 pl-2 space-y-0.5">
              <div class="font-semibold">{{ s.videoLabel }}</div>
              @if (s.videoStreamBitrate) {
                <div class="text-white/75 text-xs sm:text-sm">
                  Stream&nbsp;&nbsp;<span class="font-semibold tabular-nums">{{ s.videoStreamBitrate }}</span>
                </div>
              }
              <div class="text-white/70 text-[10px] sm:text-xs">{{ s.videoProfileLine }}</div>
              <div class="text-white/60">&rarr; {{ s.videoPlaybackMode }}</div>
              @if (s.crop) {
                <div class="text-white/60">Crop&nbsp;&nbsp;<span class="font-semibold">{{ s.crop }}</span></div>
              }
              @if (s.tonemapping) {
                <div class="text-white/60">Tonemapping&nbsp;&nbsp;<span class="font-semibold">{{ s.tonemapping }}</span></div>
              }
              @if (s.videoTranscodeReasons.length) {
                <div class="text-white/60">Reasons&nbsp;&nbsp;<span class="font-semibold">{{ s.videoTranscodeReasons.join(', ') }}</span></div>
              }
              <div class="text-white/70">Dropped frames&nbsp;&nbsp;<span class="font-semibold">{{ s.droppedFrames }}</span></div>
            </div>
          </section>

          <section>
            <div class="font-bold text-white/90 mb-0.5 text-xs sm:text-sm">Audio</div>
            <div class="text-white/80 pl-2 space-y-0.5">
              <div class="font-semibold">{{ s.audioLabel }}</div>
              @if (s.audioStreamBitrate) {
                <div class="text-white/75 text-xs sm:text-sm">
                  Stream&nbsp;&nbsp;<span class="font-semibold tabular-nums">{{ s.audioStreamBitrate }}</span>
                </div>
              }
              <div class="text-white/70 text-[10px] sm:text-xs">Sample rate&nbsp;&nbsp;{{ s.audioDetailLine }}</div>
              <div class="text-white/60">&rarr; {{ s.audioPlaybackMode }}</div>
              @if (s.audioTranscodeReasons.length) {
                <div class="text-white/60">Reasons&nbsp;&nbsp;<span class="font-semibold">{{ s.audioTranscodeReasons.join(', ') }}</span></div>
              }
            </div>
          </section>
        }
      </div>
    }
  `,
})
export class PlayerStatsOverlayComponent {
  readonly visible = input(false);
  readonly stats = input<PlayerStats | null>(null);
  readonly close = output<void>();
}
