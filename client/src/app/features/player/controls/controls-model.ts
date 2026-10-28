import type { PlaybackOption, PlaybackOutput } from '../../../core/services/playback/playback-output';
import type { SpriteMetadata } from '../../../core/utils/player.utils';

import type { PlayerControlsComponent } from './player-controls';

type Options<K extends 'availableSubtitles' | 'availableAudioTracks' | 'availableQualities'> = ReturnType<PlayerControlsComponent[K]>;

/** What the controls show of the playing output: the player's own signals while local, the cast or remote output otherwise. */
export interface ControlsModel {
  paused: boolean;
  spinner: boolean;
  videoStarted: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  canSetVolume: boolean;
  mediaTitle: string;
  episodeTitle: string;
  hasNext: boolean;
  subtitles: Options<'availableSubtitles'>;
  audioTracks: Options<'availableAudioTracks'>;
  qualities: Options<'availableQualities'>;
  activeSubtitleId: string | null;
  activeAudioTrackId: string | null;
  activeQualityId: string;
  activeQualityLabel: string;
  spriteUrl: string | null;
  spriteMetadata: SpriteMetadata | null;
  skipCueLabelKey: string | null;
}

const asOptions = (list: PlaybackOption[]) =>
  list.map((o) => ({ id: o.id, label: o.label, language: o.language, menuHead: o.head, menuSub: o.sub }));

/** Reads every control field from a non-local output; call inside a computed so the signals are tracked. */
export function outputModel(o: PlaybackOutput): ControlsModel {
  // An output marks an eco rung with its second line.
  const qualities = o.availableQualities().map((q) => ({ id: q.id, label: q.label, lowBandwidth: !!q.sub }));
  const activeQualityId = o.activeQualityId();
  return {
    paused: o.uiPaused(),
    spinner: o.buffering() || o.isStarting(),
    videoStarted: true,
    currentTime: o.position(),
    duration: o.duration(),
    volume: o.volume(),
    muted: o.muted(),
    canSetVolume: o.canSetVolume(),
    mediaTitle: o.mediaTitle(),
    episodeTitle: o.episodeTitle(),
    hasNext: o.canPlayNext(),
    subtitles: asOptions(o.availableSubtitles()),
    audioTracks: asOptions(o.availableAudioTracks()),
    qualities,
    activeSubtitleId: o.activeSubtitleId(),
    activeAudioTrackId: o.activeAudioTrackId(),
    activeQualityId,
    activeQualityLabel: qualities.find((q) => q.id === activeQualityId)?.label ?? activeQualityId,
    spriteUrl: o.spriteUrl(),
    spriteMetadata: o.spriteMetadata(),
    skipCueLabelKey: o.skipCue()?.labelKey ?? null,
  };
}
