import type { PlaybackOutput } from '../core/services/playback/playback-output';

/** The part of `PlaybackOutput` a heartbeat reads, with `over` replacing any of it. */
export function heartbeatOutput(over: Record<string, unknown> = {}): PlaybackOutput {
  return {
    reportsHere: () => true,
    position: () => 30,
    duration: () => 100,
    sessionId: () => 's',
    buffering: () => false,
    uiPaused: () => false,
    volume: () => 1,
    muted: () => false,
    activeQualityId: () => 'auto',
    availableQualities: () => [],
    audioStreamIndex: () => null,
    canSetVolume: () => true,
    activeSubtitleId: () => null,
    autoplayBlocked: () => false,
    canPlayNext: () => false,
    ...over,
  } as unknown as PlaybackOutput;
}
