import { describe, expect, it } from 'vitest';
import type { KaraokeItemState } from '../api/karaoke.models';
import { singKind, stemsReady, weightedProgress } from './karaoke-prep';

const stem = { size: 1, durationMs: 1, contentType: 'audio/ogg' };
const st = (state: KaraokeItemState['state'], stems: KaraokeItemState['stems'] = {}) => ({ state, fileId: 1, stems, lyrics: false, melody: false, cdg: false }) as KaraokeItemState;
const both = { instrumental: stem, vocals: stem };

describe('singKind', () => {
  it('maps each job state to a button state', () => {
    expect(singKind(null, false)).toBeNull();
    expect(singKind(st('none'), false)).toBe('prepare');
    expect(singKind(st('queued'), false)).toBe('queued');
    expect(singKind(st('running'), false)).toBe('running');
    expect(singKind(st('failed'), false)).toBe('retry');
    expect(singKind(st('ready', both), false)).toBe('enter');
    expect(singKind(st('ready', both), true)).toBe('exit');
  });

  it('enters as soon as both stems exist, while the lyrics steps run', () => {
    expect(singKind(st('running', both), false)).toBe('enter');
    expect(singKind(st('running', { vocals: stem }), false)).toBe('running');
    expect(stemsReady(st('running', { instrumental: stem }))).toBe(false);
  });
});

describe('weightedProgress', () => {
  it('spreads the stages, each capped at 95 by the engine', () => {
    expect(weightedProgress('separate', 0)).toBe(0);
    expect(weightedProgress('separate', 95)).toBe(25);
    expect(weightedProgress('separate', 100)).toBe(25);
    expect(weightedProgress('align', 47.5)).toBe(55);
    expect(weightedProgress('melody', 95)).toBe(100);
    expect(weightedProgress(undefined, undefined)).toBe(0);
  });
});
