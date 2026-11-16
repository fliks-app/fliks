import { describe, expect, it } from 'vitest';
import type { Media } from '../../../core/services/api/media.service';
import { asAlbumMedia, versionMeta } from './album-media';

describe('album media', () => {
  it('accepts only a full album', () => {
    expect(asAlbumMedia({ type: 'album', album: { tracks: [] } } as unknown as Media)).not.toBeNull();
    expect(asAlbumMedia({ type: 'album', album: { trackCount: 3 } } as unknown as Media)).toBeNull();
    expect(asAlbumMedia({ type: 'movie' } as Media)).toBeNull();
  });

  it('tells a release by size, country and year', () => {
    expect(versionMeta({ trackCount: 15, country: 'CA', releaseDate: '2005-03-01' }, '15 tracks')).toBe('15 tracks · CA · 2005');
    expect(versionMeta({ trackCount: null, country: null, releaseDate: null }, '')).toBe('');
  });
});
