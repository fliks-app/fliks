import { Signal, WritableSignal } from '@angular/core';
import { SpriteMetadata } from '../utils/player.utils';

/** Minimal shape the cast-overlay template needs for a track/quality row. */
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

/**
 * One playback surface for the cast-overlay UI: a Chromecast session or a
 * remote target, whichever is active. Keeps the control component and its
 * template ignorant of which device is actually being driven.
 */
export interface PlaybackTarget {
  readonly buffering: Signal<boolean>;
  readonly currentTime: Signal<number>;
  readonly duration: Signal<number>;
  readonly isConnected: Signal<boolean>;
  readonly isPaused: Signal<boolean>;
  readonly muted: Signal<boolean>;
  readonly volume: Signal<number>;
  readonly hasMedia: Signal<boolean>;
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
  readonly expanded: WritableSignal<boolean>;

  seek(time: number): void;
  setVolume(level: number): void;
  toggleMute(): void;
  togglePlayPause(): void;
  selectSubtitle(sub: PlaybackOption | null): void;
  selectAudio(track: PlaybackOption | null): void;
  selectQuality(quality: PlaybackOption): void;
  /** False when the target's engine cannot change a per-stream level, so the
   *  slider is hidden instead of doing nothing. */
  readonly canSetVolume: Signal<boolean>;
  /** The skip offer that applies right now, or null. `labelKey` is an i18n key
   *  so the surface stays translation-only. */
  readonly skipCue: Signal<{ labelKey: string } | null>;
  /** Take the current skip offer. No-op when there is none. */
  skip(): void;
  /** Something follows what is playing, so the surface can offer it whatever
   *  the playhead is doing — unlike {@link skipCue}, which is outro-bound. */
  readonly canPlayNext: Signal<boolean>;
  /** Move to the next item. No-op when {@link canPlayNext} is false. */
  playNext(): void;
  /** A load has been sent and the target has not reported back yet. Always
   *  false on Cast, whose sender mirrors the media locally from the start. */
  readonly isStarting: Signal<boolean>;
  /** Present but playing nothing. Always false on Cast, where a session only
   *  exists around a media. */
  readonly isIdle: Signal<boolean>;
  /** The selected target dropped off the listing. Always false on Cast, whose
   *  session disappearing already ends `isConnected`. */
  readonly targetOffline: Signal<boolean>;
  /** The target cannot start on its own: only a gesture on that device will. */
  readonly autoplayBlocked: Signal<boolean>;
  /** Stop what the target is playing. On Cast the session IS the playback, so
   *  the two collapse; a network target keeps existing after it stops. */
  stopPlayback(): void;
  /** Hand the target back without touching its playback. False on Cast, where
   *  there is nothing to hand back to. */
  readonly canStopControlling: boolean;
  disconnect(): void;
}
