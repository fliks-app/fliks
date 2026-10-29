import type { PlaybackOption, PlaybackOutput } from '../../../core/services/playback/playback-output';
import type { SpriteMetadata } from '../../../core/utils/player.utils';
import { inOutroRange } from '../../../core/utils/player.utils';
import type { PlaybackTimeline } from '../../../core/services/playback/playback-output';
import { NO_NOW_PLAYING, type NowPlayingMetadata } from '../../../core/services/playback/now-playing-metadata.service';

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
  logoUrl: string | null;
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
  timeline: PlaybackTimeline;
  /** The credits have started and something follows; a local player keeps its own timed cue. */
  nextCue: boolean;
}

const asOptions = (list: PlaybackOption[]) =>
  list.map((o) => ({ id: o.id, label: o.label, language: o.language, menuHead: o.head, menuSub: o.sub }));

/** Reads every control field from a non-local output; call inside a computed so the signals are tracked. */
export function outputModel(o: PlaybackOutput, meta: NowPlayingMetadata | null): ControlsModel {
  const { title, episodeLabel, logoUrl } = meta ?? NO_NOW_PLAYING;
  // An output marks an eco rung with its second line.
  const qualities = o.availableQualities().map((q) => ({ id: q.id, label: q.label, lowBandwidth: !!q.sub }));
  const activeQualityId = o.activeQualityId();
  const timeline = o.timeline();
  return {
    paused: o.uiPaused(),
    spinner: o.buffering() || o.isStarting(),
    videoStarted: true,
    currentTime: o.position(),
    duration: o.duration(),
    volume: o.volume(),
    muted: o.muted(),
    canSetVolume: o.canSetVolume(),
    mediaTitle: title,
    episodeTitle: episodeLabel,
    logoUrl,
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
    timeline,
    nextCue: o.canPlayNext() && inOutroRange(timeline.outro, o.position()),
  };
}
