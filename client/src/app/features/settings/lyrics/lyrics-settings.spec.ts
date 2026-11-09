import { listJson, listText, ranked } from './lyrics-settings';

describe('lyrics settings lists', () => {
  it('reads a stored array as text and a bad value as empty', () => {
    expect(listText('["a","b"]', '\n')).toBe('a\nb');
    expect(listText('nope', '\n')).toBe('');
    expect(listText(undefined, ', ')).toBe('');
  });

  it('writes the entries trimmed, without dots and blanks', () => {
    expect(listJson('lrc, .ttml  srt,,', /[,\s]+/)).toBe('["lrc","ttml","srt"]');
    expect(listJson('x:a\n\n y:b ', /\n/)).toBe('["x:a","y:b"]');
  });

  it('ranks the shown providers by the stored order, the unnamed ones last', () => {
    expect(ranked(['a', 'b', 'c'], ['c', 'x', 'a'])).toEqual(['c', 'a', 'b']);
  });
});
