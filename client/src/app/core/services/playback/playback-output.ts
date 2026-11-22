import { Signal } from '@angular/core';
import { SpriteMetadata, TimeMarker } from '../../utils/player.utils';
import type { EdlRange } from '../../utils/edl-policy';
import type { CastPlayerService } from '../cast-player.service';
import type { CastSubtitleStyle } from '../cast-settings.service';
import type { LaunchTracks } from '../track-manager.service';
import type { MusicTrackRequest } from '../audio-player/music-queue';
import type { StemMode } from '../audio-player/stem-mix';

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
  /** An eco rung: one exists per height, so a beat carries the flag for a controller to tell them apart. */
  lowBandwidth?: boolean;
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

/** Intro and credits ranges, chapters and EDL ranges of the playing file, on the output's own clock. */
export interface PlaybackTimeline {
  intro: TimeMarker | null;
  outro: TimeMarker | null;
  chapters: { startSeconds: number; endSeconds: number; title?: string }[];
  edl: readonly EdlRange[];
}

export const NO_TIMELINE: PlaybackTimeline = { intro: null, outro: null, chapters: [], edl: [] };

/** Everything an output hands to the next one; every field is required so a handoff cannot drop one. */
export interface PlaybackSnapshot {
  item: { fileId: number; mediaId: number; episodeId?: number; itemId?: number };
  position: number;
  paused: boolean;
  tracks: LaunchTracks;
}

/** Something that plays (this device's engine, a Chromecast session or another Fliks device): what the controls show and what the party sync drives. */
export interface PlaybackOutput {
  readonly sync: PlaybackSync;

  readonly isConnected: Signal<boolean>;
  /** The stream session this device holds for what plays; none when another device holds it. */
  readonly sessionId: () => string | undefined;
  /** This device reports the output's progress: false for another device's output (it beats for itself) and a
   *  receiver another account drives. */
  readonly reportsHere: () => boolean;
  /** The output has a media (a remote target is present even with nothing playing). */
  readonly hasMedia: Signal<boolean>;
  // ready, item, paused and position are plain reads: an engine's own state is not reactive.
  /** Loaded and seekable: the party only drives an output that is ready. */
  readonly ready: () => boolean;
  /** The identity of what plays; display metadata comes from `NowPlayingMetadataService`. */
  readonly item: () => { mediaId: number; episodeId: number | undefined; itemId?: number };
  readonly paused: () => boolean;
  /** What a handoff carries; null while nothing is open. */
  snapshot(): PlaybackSnapshot | null;
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
  readonly canSetVolume: () => boolean;

  readonly spriteUrl: Signal<string | null>;
  readonly spriteMetadata: Signal<SpriteMetadata | null>;
  readonly availableSubtitles: Signal<PlaybackOption[]>;
  readonly availableAudioTracks: Signal<PlaybackOption[]>;
  readonly availableQualities: Signal<PlaybackOption[]>;
  readonly activeSubtitleId: Signal<string | null>;
  readonly activeAudioTrackId: Signal<string | null>;
  readonly activeQualityId: Signal<string>;
  /** The playing audio as a `streamInfo` index, the one space every device agrees on. */
  readonly audioStreamIndex: () => number | null;

  /** What the seekbar marks and the skip cues key on. */
  readonly timeline: Signal<PlaybackTimeline>;
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
  /** A pick named by another device's ids (a remote command): mapped to this output's own track, settled once applied. */
  selectAudioById(trackId: string): Promise<void>;
  selectSubtitleById(id: string | null): Promise<void>;
  selectQualityById(id: string): Promise<void>;
  /** Take the current skip offer. No-op when there is none. */
  skip(): void;
  /** Move to the next item. No-op when {@link canPlayNext} is false. */
  playNext(): void;
  /** Stop what the output is playing. On Cast the session IS the playback, so the two collapse. */
  stopPlayback(): void;
  disconnect(): void;
  /** Present when the output keeps its own subtitle style: the appearance panel edits it instead of the local one. */
  readonly subtitleStyle?: Signal<CastSubtitleStyle>;
  setSubtitleStyle?(style: CastSubtitleStyle): void;
}

/** What `CastPlayerService.startCast` needs to describe the media being handed to a receiver. */
export type CastStart = Parameters<CastPlayerService['startCast']>[0];

/** What a music hand-over carries; the queue itself stays on the audio player. */
export interface MusicSnapshot {
  track: MusicTrackRequest;
  position: number;
  paused: boolean;
  karaoke: { mode: StemMode; level: number };
}

/** What the video player gives up when playback leaves this device. */
export interface VideoHandoff {
  kind: 'video';
  snapshot: PlaybackSnapshot;
  cast: CastStart;
  /** The first load had not settled, so the subtitle pick may have been refused: the receiver resolves its own. */
  resolveSubtitle: boolean;
  audioLanguage?: string;
  /** This device's own stream session, stopped once the receiver streams on its own. */
  localSessionId?: string;
}
export interface MusicHandoff {
  kind: 'music';
  snapshot: MusicSnapshot;
}
export type LocalHandoff = VideoHandoff | MusicHandoff;

/** A player of this device that playback leaves and comes back to. */
export interface LocalPlayer<H extends LocalHandoff> {
  /** An item is open: it falls silent for a receiver that already plays. */
  holds(): boolean;
  /** Pause, mute and unload, handing over what the next output needs; null when nothing may leave. */
  release(): Promise<H | null>;
  /** Pause and mute without unloading: another output already plays. */
  stepAside(): void;
  /** Load again, or for the first time, where the snapshot says. */
  resume(snapshot: H['snapshot']): Promise<void>;
}

/** The video player's output: the one that can leave this device and come back. */
export interface LocalOutput extends PlaybackOutput, LocalPlayer<VideoHandoff> {}
