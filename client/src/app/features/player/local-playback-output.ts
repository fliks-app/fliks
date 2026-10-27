import { computed, Signal } from '@angular/core';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import type { PlaybackOption, PlaybackOutput } from '../../core/services/playback/playback-output';
import type { PlayerStateService } from '../../core/services/player-state.service';
import type { SpriteMetadata } from '../../core/utils/player.utils';

/** Closest a seek may land to the target before it is skipped: a nearer one would only restart a transcode. */
const SEEK_SLACK_S = 0.25;

/** What the player lends its local output. */
export interface LocalOutputHost {
  engine(): PlaybackEngine | null;
  mediaId(): number;
  episodeId(): number | undefined;
  /** Locked seek that does not go through the user path, so nothing is re-emitted. */
  seekTo(time: number): void;
  pausePlayback(): Promise<void>;
  playLocal(): void;
  position(): number;
  mediaTitle: Signal<string>;
  episodeTitle: Signal<string>;
  fanartUrl: Signal<string | null>;
  spriteUrl: Signal<string | null>;
  spriteMetadata: Signal<SpriteMetadata | null>;
  subtitles: Signal<PlaybackOption[]>;
  audioTracks: Signal<PlaybackOption[]>;
  qualities: Signal<PlaybackOption[]>;
  activeSubtitleId: Signal<string | null>;
  activeAudioTrackId: Signal<string | null>;
  activeQualityId: Signal<string>;
  skipCue: Signal<{ labelKey: string } | null>;
  canPlayNext: Signal<boolean>;
  skip(): void;
  playNext(): void;
  selectSubtitle(id: string | null): void;
  selectAudio(id: string): void;
  selectQuality(id: string): void;
  onBack(): void;
}

/** This device's player engine as a playback output. */
export class LocalPlaybackOutput implements PlaybackOutput {
  readonly sync = {
    slackS: SEEK_SLACK_S,
    stepS: () => this.host.engine()?.positionStepS ?? 0,
    rate: {
      get: () => this.host.engine()?.playbackRate ?? 1,
      set: (r: number) => {
        const engine = this.host.engine();
        if (engine) engine.playbackRate = r;
      },
    },
  };

  readonly isConnected = computed(() => true);
  readonly hasMedia = computed(() => true);
  readonly ready = () => !!this.host.engine() && this.state.videoStarted();
  readonly item = () => ({ mediaId: this.host.mediaId(), episodeId: this.host.episodeId() });
  readonly paused = () => this.host.engine()?.paused === true;
  readonly position = () => this.host.position();
  readonly canSetVolume = computed(() => true);
  readonly isIdle = computed(() => false);
  readonly targetOffline = computed(() => false);
  readonly canStopControlling = false;
  readonly uiPaused: PlaybackOutput['uiPaused'];
  readonly buffering: PlaybackOutput['buffering'];
  readonly ended: PlaybackOutput['ended'];
  readonly seekLocked: PlaybackOutput['seekLocked'];
  readonly duration: PlaybackOutput['duration'];
  readonly muted: PlaybackOutput['muted'];
  readonly volume: PlaybackOutput['volume'];
  readonly mediaTitle: PlaybackOutput['mediaTitle'];
  readonly episodeTitle: PlaybackOutput['episodeTitle'];
  readonly fanartUrl: PlaybackOutput['fanartUrl'];
  readonly spriteUrl: PlaybackOutput['spriteUrl'];
  readonly spriteMetadata: PlaybackOutput['spriteMetadata'];
  readonly availableSubtitles: PlaybackOutput['availableSubtitles'];
  readonly availableAudioTracks: PlaybackOutput['availableAudioTracks'];
  readonly availableQualities: PlaybackOutput['availableQualities'];
  readonly activeSubtitleId: PlaybackOutput['activeSubtitleId'];
  readonly activeAudioTrackId: PlaybackOutput['activeAudioTrackId'];
  readonly activeQualityId: PlaybackOutput['activeQualityId'];
  readonly skipCue: PlaybackOutput['skipCue'];
  readonly canPlayNext: PlaybackOutput['canPlayNext'];
  readonly isStarting: PlaybackOutput['isStarting'];
  readonly autoplayBlocked: PlaybackOutput['autoplayBlocked'];

  constructor(
    private readonly host: LocalOutputHost,
    private readonly state: PlayerStateService,
  ) {
    this.uiPaused = state.uiPaused;
    this.buffering = state.buffering;
    this.ended = state.ended;
    this.seekLocked = state.seekLocked;
    this.duration = state.duration;
    this.muted = state.muted;
    this.volume = state.volume;
    this.mediaTitle = host.mediaTitle;
    this.episodeTitle = host.episodeTitle;
    this.fanartUrl = host.fanartUrl;
    this.spriteUrl = host.spriteUrl;
    this.spriteMetadata = host.spriteMetadata;
    this.availableSubtitles = host.subtitles;
    this.availableAudioTracks = host.audioTracks;
    this.availableQualities = host.qualities;
    this.activeSubtitleId = host.activeSubtitleId;
    this.activeAudioTrackId = host.activeAudioTrackId;
    this.activeQualityId = host.activeQualityId;
    this.skipCue = host.skipCue;
    this.canPlayNext = host.canPlayNext;
    this.isStarting = state.startingPlayback;
    this.autoplayBlocked = state.autoplayBlocked;
  }

  seek = (time: number) => this.host.seekTo(time);
  play = () => this.host.playLocal();
  pause = () => this.host.pausePlayback();
  togglePlayPause = () => (this.uiPaused() ? this.play() : void this.pause());
  setVolume = (level: number) => {
    const engine = this.host.engine();
    if (engine) engine.volume = level;
  };
  toggleMute = () => {
    const engine = this.host.engine();
    if (engine) engine.muted = !engine.muted;
  };
  selectSubtitle = (sub: PlaybackOption | null) => this.host.selectSubtitle(sub?.id ?? null);
  selectAudio = (track: PlaybackOption | null) => track && this.host.selectAudio(track.id);
  selectQuality = (quality: PlaybackOption) => this.host.selectQuality(quality.id);
  skip = () => this.host.skip();
  playNext = () => this.host.playNext();
  stopPlayback = () => this.host.onBack();
  disconnect = () => this.host.onBack();
}
