import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { UpperCasePipe } from '@angular/common';

export interface PlayerStats {
  // Stream (Flux)
  container: string;
  containerBitrate: string;
  outputFormat: string;
  outputBitrate: string;
  outputFps: string;
  audioTranscodeNote: string;

  // Video
  videoLabel: string;          // e.g. "4K HEVC" or "1080p H264"
  videoProfileLine: string;    // e.g. "Main 10 153 11 mbps 23,976 fps"
  videoPlaybackMode: string;   // "Lecture directe" or "Transcodage (VAAPI)"
  droppedFrames: number;

  // Audio
  audioLabel: string;          // e.g. "French AC3 5.1 (Par défaut)"
  audioDetailLine: string;     // e.g. "640 kbps 48000 Hz"
  audioPlaybackMode: string;   // "Lecture directe" or "Transcoder (AAC 192 kbps)"
}

@Component({
  selector: 'app-player-stats-overlay',
  imports: [UpperCasePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="absolute bottom-20 left-4 z-50 bg-black/85 text-white text-sm p-5 rounded-xl min-w-[320px] max-w-md select-none backdrop-blur-sm shadow-2xl">

        <!-- Close button -->
        <button
          class="absolute top-3 right-3 text-white/60 hover:text-white text-lg leading-none cursor-pointer"
          (click)="close.emit()"
        >&times;</button>

        @if (stats(); as s) {
          <!-- Flux -->
          <section class="mb-4">
            <div class="font-bold text-white/90 mb-1">Flux</div>
            <div class="text-white/80 pl-2 space-y-0.5">
              <div class="font-semibold">{{ s.container | uppercase }} ({{ s.containerBitrate }})</div>
              @if (s.outputFormat) {
                <div class="text-white/60">&rarr; {{ s.outputFormat | uppercase }} ({{ s.outputBitrate }} {{ s.outputFps }})</div>
              }
              @if (s.audioTranscodeNote) {
                <div class="text-white/50 text-xs">{{ s.audioTranscodeNote }}</div>
              }
            </div>
          </section>

          <!-- Vidéo -->
          <section class="mb-4">
            <div class="font-bold text-white/90 mb-1">Vidéo</div>
            <div class="text-white/80 pl-2 space-y-0.5">
              <div class="font-semibold">{{ s.videoLabel }}</div>
              <div class="text-white/70 text-xs">{{ s.videoProfileLine }}</div>
              <div class="text-white/60">&rarr; {{ s.videoPlaybackMode }}</div>
              <div class="text-white/70">Dropped Frames&nbsp;&nbsp;<span class="font-semibold">{{ s.droppedFrames }}</span></div>
            </div>
          </section>

          <!-- Audio -->
          <section>
            <div class="font-bold text-white/90 mb-1">Audio</div>
            <div class="text-white/80 pl-2 space-y-0.5">
              <div class="font-semibold">{{ s.audioLabel }}</div>
              <div class="text-white/70 text-xs">{{ s.audioDetailLine }}</div>
              <div class="text-white/60">&rarr; {{ s.audioPlaybackMode }}</div>
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
