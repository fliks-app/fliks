import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';

export interface PlayerStats {
  // Video
  videoCodec: string;
  resolution: string;
  videoBitrate: string;
  frameRate: string;
  profile: string;
  // Audio
  audioCodec: string;
  audioChannels: string;
  audioLanguage: string;
  audioBitrate: string;
  // Playback
  playbackMode: string;
  hwAccel: string;
  bufferLength: number;
  droppedFrames: number;
  decodedFrames: number;
  // Network
  estimatedBandwidth: string;
  // Session
  position: string;
  duration: string;
}

@Component({
  selector: 'app-player-stats-overlay',
  imports: [TranslateModule, UpperCasePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="absolute bottom-20 left-4 z-50 bg-black/80 text-green-400 font-mono text-xs p-4 rounded-lg max-w-md space-y-2 select-none">
        <div class="font-bold text-green-300 mb-2">Stats for Nerds</div>

        @if (stats(); as s) {
          <div>
            <span class="text-green-300/60">{{ 'player.stats_video' | translate }}:</span>
            {{ s.videoCodec }} {{ s.resolution }} {{ s.profile }}
          </div>
          <div>
            <span class="text-green-300/60">{{ 'player.stats_video' | translate }} bitrate:</span>
            {{ s.videoBitrate }} @ {{ s.frameRate }}
          </div>
          <div>
            <span class="text-green-300/60">{{ 'player.stats_audio' | translate }}:</span>
            {{ s.audioCodec }} {{ s.audioChannels }} ({{ s.audioLanguage }})
          </div>
          <div>
            <span class="text-green-300/60">{{ 'player.stats_playback' | translate }}:</span>
            {{ s.playbackMode }}@if (s.hwAccel !== 'none') { ({{ s.hwAccel | uppercase }})} — buffer {{ s.bufferLength.toFixed(1) }}s
          </div>
          <div>
            <span class="text-green-300/60">Frames:</span>
            {{ s.decodedFrames }} decoded, {{ s.droppedFrames }} dropped
          </div>
          <div>
            <span class="text-green-300/60">{{ 'player.stats_network' | translate }}:</span>
            {{ s.estimatedBandwidth }}
          </div>
          <div>
            <span class="text-green-300/60">Position:</span>
            {{ s.position }} / {{ s.duration }}
          </div>
        }
      </div>
    }
  `,
})
export class PlayerStatsOverlayComponent {
  readonly visible = input(false);
  readonly stats = input<PlayerStats | null>(null);
}
