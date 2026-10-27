import { Signal } from '@angular/core';
import { SpriteMetadata } from '../../utils/player.utils';

/** Minimal shape the playback surfaces need for a track/quality row. */
export interface PlaybackOption {
  id: string;
  label: string;
  /** Source language code, used to order the pickers. */
  language?: string;
  /** Two-line row: language above, codec and channels below. Falls back to
   *  `label` on a source that cannot split it. */
  head?: string;
  sub?: string;
}

/** How the party sync corrects drift on an output. */
export interface PlaybackSync {
  /** A seek closer than this to the target is skipped. */
  readonly slackS: number;
  /** Extra slack for an engine whose position moves in steps; absent means continuous. */
  readonly stepS?: () => number;
  /** Drift thresholds; absent means the local defaults with rate nudging. */
  readonly drift?: { ignoreS: number; cooldownMs: number };
  readonly rate?: { get(): number; set(rate: number): void };
}

/** Something that plays (this device's engine, a Chromecast session or another Fliks device): what the controls show and what the party sync drives. */
export interface PlaybackOutput {
  readonly sync: PlaybackSync;

  readonly isConnected: Signal<boolean>;
  /** The output has a media (a remote target is present even with nothing playing). */
  readonly hasMedia: Signal<boolean>;
  // ready, item, paused and position are plain reads: an engine's own state is not reactive.
  /** Loaded and seekable: the party only drives an output that is ready. */
  readonly ready: () => boolean;
  readonly item: () => { mediaId: number; episodeId: number | undefined };
  readonly paused: () => boolean;
  /** What the play control shows: differs from `paused` while a launch is in flight. */
  readonly uiPaused: Signal<boolean>;
  readonly buffering: Signal<boolean>;
  readonly ended: Signal<boolean>;
  readonly seekLocked: Signal<boolean>;
  readonly position: () => number;
  readonly duration: Signal<number>;
  readonly muted: Signal<boolean>;
  readonly volume: Signal<number>;
  /** False when the engine cannot change a per-stream level, so the slider is hidden. */
  readonly canSetVolume: Signal<boolean>;

  readonly mediaTitle: Signal<string>;
  readonly episodeTitle: Signal<string>;
  readonly fanartUrl: Signal<string | null>;
  readonly spriteUrl: Signal<string | null>;
  readonly spriteMetadata: Signal<SpriteMetadata | null>;
  readonly availableSubtitles: Signal<PlaybackOption[]>;
  readonly availableAudioTracks: Signal<PlaybackOption[]>;
  readonly availableQualities: Signal<PlaybackOption[]>;
  readonly activeSubtitleId: Signal<string | null>;
  readonly activeAudioTrackId: Signal<string | null>;
  readonly activeQualityId: Signal<string>;

  /** The skip offer that applies right now, or null. `labelKey` is an i18n key so the surface stays translation-only. */
  readonly skipCue: Signal<{ labelKey: string } | null>;
  /** Something follows what is playing, so the surface can offer it whatever the playhead is doing. */
  readonly canPlayNext: Signal<boolean>;
  /** A load has been sent and the output has not reported back yet. */
  readonly isStarting: Signal<boolean>;
  /** Present but playing nothing. */
  readonly isIdle: Signal<boolean>;
  /** The selected output dropped off the listing. */
  readonly targetOffline: Signal<boolean>;
  /** The output cannot start on its own: only a gesture on that device will. */
  readonly autoplayBlocked: Signal<boolean>;
  /** Hand the output back without touching its playback; false where there is nothing to hand back to. */
  readonly canStopControlling: boolean;

  /** Moves the playhead on this output only: never echoes to a party. */
  seek(time: number): void;
  play(): void;
  pause(): Promise<void>;
  togglePlayPause(): void;
  setVolume(level: number): void;
  toggleMute(): void;
  selectSubtitle(sub: PlaybackOption | null): void;
  selectAudio(track: PlaybackOption | null): void;
  selectQuality(quality: PlaybackOption): void;
  /** Take the current skip offer. No-op when there is none. */
  skip(): void;
  /** Move to the next item. No-op when {@link canPlayNext} is false. */
  playNext(): void;
  /** Stop what the output is playing. On Cast the session IS the playback, so the two collapse. */
  stopPlayback(): void;
  disconnect(): void;
}
