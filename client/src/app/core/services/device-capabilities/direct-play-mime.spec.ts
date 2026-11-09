import { directPlayMime } from './direct-play-mime';

describe('directPlayMime', () => {
  it.each([
    ['matroska,webm', 'video/x-matroska'],
    ['mkv', 'video/x-matroska'],
    ['webm', 'video/webm'],
    ['mpegts', 'video/mp2t'],
    ['mov,mp4,m4a,3gp,3g2,mj2', 'video/mp4'],
    [undefined, 'video/mp4'],
  ])('maps %s to %s', (container, mime) => expect(directPlayMime(container)).toBe(mime));
});
