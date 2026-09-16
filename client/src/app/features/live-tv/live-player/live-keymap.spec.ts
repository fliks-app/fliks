import { describe, expect, it } from 'vitest';
import { liveKeyAction, type LiveKeyContext } from './live-keymap';

const ctx = (over: Partial<LiveKeyContext> = {}): LiveKeyContext => ({
  visible: false,
  guideOpen: false,
  ...over,
});

describe('liveKeyAction', () => {
  it('zaps on the dedicated channel keys whatever is on screen', () => {
    for (const visible of [true, false]) {
      expect(liveKeyAction('ChannelUp', ctx({ visible }))).toEqual({ kind: 'zap', by: 1 });
      expect(liveKeyAction('PageDown', ctx({ visible }))).toEqual({ kind: 'zap', by: -1 });
    }
  });

  it('zaps on up and down only while the overlay is down', () => {
    expect(liveKeyAction('ArrowUp', ctx())).toEqual({ kind: 'zap', by: 1 });
    expect(liveKeyAction('ArrowDown', ctx())).toEqual({ kind: 'zap', by: -1 });
  });

  it('leaves every arrow to the focus layer once the overlay is up', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(liveKeyAction(key, ctx({ visible: true }))).toEqual({ kind: 'none' });
    }
  });

  it('scrubs sideways only while the overlay is down', () => {
    expect(liveKeyAction('ArrowLeft', ctx())).toEqual({ kind: 'scrub' });
    expect(liveKeyAction('ArrowRight', ctx())).toEqual({ kind: 'scrub' });
  });

  it('hands every arrow to the panel while it is open', () => {
    for (const visible of [true, false]) {
      expect(liveKeyAction('ArrowUp', ctx({ visible, guideOpen: true }))).toEqual({ kind: 'none' });
    }
  });

  it('takes a digit whatever the overlay is doing', () => {
    expect(liveKeyAction('7', ctx({ visible: true }))).toEqual({ kind: 'digit', digit: '7' });
    expect(liveKeyAction('0', ctx())).toEqual({ kind: 'digit', digit: '0' });
  });
});

describe('liveKeyAction, the OK button', () => {
  it('raises the bar rather than pressing a button nobody can see', () => {
    expect(liveKeyAction('Enter', ctx())).toEqual({ kind: 'wake' });
  });

  it('commits a typed channel number once the bar is up', () => {
    expect(liveKeyAction('Enter', ctx({ visible: true }))).toEqual({ kind: 'commitNumber' });
  });

  it('is left to the focused row inside the panel', () => {
    expect(liveKeyAction('Enter', ctx({ visible: true, guideOpen: true }))).toEqual({ kind: 'none' });
  });
});
