import { itemArtwork } from './media-artwork.util';

describe('itemArtwork', () => {
  it('prefers the still, then the fanart, then the poster', () => {
    expect(itemArtwork({ stillUrl: '/s.jpg', fanartUrl: '/f.jpg', posterUrl: '/p.jpg' })).toBe('/s.jpg');
    expect(itemArtwork({ fanartUrl: '/f.jpg', posterUrl: '/p.jpg' })).toBe('/f.jpg');
    expect(itemArtwork({ posterUrl: '/p.jpg' })).toBe('/p.jpg');
    expect(itemArtwork({})).toBeNull();
  });
});
