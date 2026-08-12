import { resolveSubtitleAbsolutePath } from './subtitle-path.util';

describe('resolveSubtitleAbsolutePath', () => {
  it('resolves a relative store under the media root', () => {
    expect(resolveSubtitleAbsolutePath('/media', 'Show/s01e01.srt')).toBe('/media/Show/s01e01.srt');
  });

  it('accepts an absolute store that stays under the media root', () => {
    expect(resolveSubtitleAbsolutePath('/media', '/media/Show/s01e01.srt')).toBe('/media/Show/s01e01.srt');
  });

  it('VERDICT: refuses an absolute store outside the media root, and a relative escape', () => {
    expect(resolveSubtitleAbsolutePath('/media', '/etc/passwd')).toBeNull();
    expect(resolveSubtitleAbsolutePath('/media', '../../etc/passwd')).toBeNull();
  });

  it('refuses an empty store or an unset root', () => {
    expect(resolveSubtitleAbsolutePath('/media', '  ')).toBeNull();
    expect(resolveSubtitleAbsolutePath(null, 'a.srt')).toBeNull();
  });
});
