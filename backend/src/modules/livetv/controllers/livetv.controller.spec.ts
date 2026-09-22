import { SEGMENT_NAME_RE } from './livetv.controller';

describe('SEGMENT_NAME_RE', () => {
  it('accepts a segment past ffmpeg\'s 5-digit padding, since %05d is a minimum width', () => {
    expect(SEGMENT_NAME_RE.test('seg-100000.m4s')).toBe(true);
    expect(SEGMENT_NAME_RE.test('seg-100000.ts')).toBe(true);
  });

  it('still accepts a normal segment and the init segment', () => {
    expect(SEGMENT_NAME_RE.test('seg-00000.m4s')).toBe(true);
    expect(SEGMENT_NAME_RE.test('init.mp4')).toBe(true);
  });

  it('rejects a name that only pretends to be a segment', () => {
    expect(SEGMENT_NAME_RE.test('../../etc/passwd')).toBe(false);
    expect(SEGMENT_NAME_RE.test('seg-abcde.m4s')).toBe(false);
  });
});
