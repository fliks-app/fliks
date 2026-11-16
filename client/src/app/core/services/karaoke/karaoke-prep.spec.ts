import { describe, expect, it } from 'vitest';
import type { KaraokeItemState } from '../api/karaoke.models';
import { singKind, weightedProgress } from './karaoke-prep';

const st = (state: KaraokeItemState['state']) => ({ state, fileId: 1, stems: {}, lyrics: false, melody: false, cdg: false }) as KaraokeItemState;

describe('singKind', () => {
  it('maps each job state to a button state', () => {
    expect(singKind(null, false)).toBeNull();
    expect(singKind(st('none'), false)).toBe('prepare');
    expect(singKind(st('queued'), false)).toBe('queued');
    expect(singKind(st('running'), false)).toBe('running');
    expect(singKind(st('failed'), false)).toBe('retry');
    expect(singKind(st('ready'), false)).toBe('enter');
    expect(singKind(st('ready'), true)).toBe('exit');
  });
});

describe('weightedProgress', () => {
  it('spreads the stages over 0-70, 70-90 and 90-100', () => {
    expect(weightedProgress('separate', 0)).toBe(0);
    expect(weightedProgress('separate', 100)).toBe(70);
    expect(weightedProgress('align', 50)).toBe(80);
    expect(weightedProgress('melody', 100)).toBe(100);
    expect(weightedProgress(undefined, undefined)).toBe(0);
    expect(weightedProgress('separate', 60)).toBe(42);
  });
});
