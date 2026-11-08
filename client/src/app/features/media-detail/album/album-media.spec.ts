import { describe, expect, it } from 'vitest';
import type { AlbumDetail, AlbumEdition } from '../../../core/services/api/music.models';
import type { Media } from '../../../core/services/api/media.service';
import { asAlbumMedia, defaultEditionId } from './album-media';

const ed = (id: number, hasFiles = false) => ({ id, hasFiles }) as AlbumEdition;
const detail = (o: Partial<AlbumDetail>) => ({ tracks: [], editions: [], targetEditionId: null, ...o }) as unknown as AlbumDetail;

describe('album media', () => {
  it('accepts only a full album', () => {
    expect(asAlbumMedia({ type: 'album', album: detail({}) } as unknown as Media)).not.toBeNull();
    expect(asAlbumMedia({ type: 'album', album: { trackCount: 3 } } as unknown as Media)).toBeNull();
    expect(asAlbumMedia({ type: 'movie' } as Media)).toBeNull();
  });

  it('opens on the target edition, else one with files, else the first', () => {
    expect(defaultEditionId(detail({ editions: [ed(1), ed(2, true), ed(3)], targetEditionId: 3 }))).toBe(3);
    expect(defaultEditionId(detail({ editions: [ed(1), ed(2, true)] }))).toBe(2);
    expect(defaultEditionId(detail({ editions: [ed(1)] }))).toBe(1);
    expect(defaultEditionId(detail({}))).toBeNull();
  });
});
