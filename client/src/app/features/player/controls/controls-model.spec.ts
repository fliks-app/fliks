import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import type { PlaybackOutput } from '../../../core/services/playback/playback-output';
import { outputModel } from './controls-model';
import { NO_NOW_PLAYING } from '../../../core/services/playback/now-playing-metadata.service';

const META = { ...NO_NOW_PLAYING, title: 'Show', episodeLabel: 'S1:E2 - Pilot', logoUrl: '/logo.png' };

function output(position: number, canPlayNext: boolean) {
  const timeline = { intro: { startSeconds: 5, endSeconds: 60 }, outro: { startSeconds: 900, endSeconds: 1000 }, chapters: [], edl: [] };
  return {
    uiPaused: signal(false), buffering: signal(false), isStarting: signal(false), position: () => position,
    duration: signal(1000), volume: signal(1), muted: signal(false), canSetVolume: signal(true),
    canPlayNext: signal(canPlayNext),
    availableSubtitles: signal([]), availableAudioTracks: signal([]), availableQualities: signal([]),
    activeSubtitleId: signal(null), activeAudioTrackId: signal(null), activeQualityId: signal('auto'),
    spriteUrl: signal(null), spriteMetadata: signal(null), skipCue: signal(null), timeline: signal(timeline),
  } as unknown as PlaybackOutput;
}

describe('outputModel', () => {
  it('carries the episode label and the seekbar ranges of the output', () => {
    const m = outputModel(output(10, true), META);
    expect(m.episodeTitle).toBe('S1:E2 - Pilot');
    expect(m.mediaTitle).toBe('Show');
    expect(m.logoUrl).toBe('/logo.png');
    expect(m.timeline.intro).toEqual({ startSeconds: 5, endSeconds: 60 });
    expect(m.timeline.outro?.startSeconds).toBe(900);
  });

  it('offers the next episode only in the credits and when one follows', () => {
    expect(outputModel(output(10, true), META).nextCue).toBe(false);
    expect(outputModel(output(950, false), META).nextCue).toBe(false);
    expect(outputModel(output(950, true), META).nextCue).toBe(true);
  });
});
