import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findLocalArtwork } from './local-artwork.util';

describe('findLocalArtwork', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fliks-artwork-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers the basename-prefixed poster over a generic one', async () => {
    writeFileSync(join(dir, 'Quiet Harbour-poster.jpg'), '');
    writeFileSync(join(dir, 'poster.jpg'), '');

    const out = await findLocalArtwork(dir, 'Quiet Harbour');
    expect(out.poster).toBe(join(dir, 'Quiet Harbour-poster.jpg'));
  });

  it('falls back through folder, cover, movie in order', async () => {
    writeFileSync(join(dir, 'cover.png'), '');
    writeFileSync(join(dir, 'movie.jpg'), '');

    const out = await findLocalArtwork(dir);
    expect(out.poster).toBe(join(dir, 'cover.png'));
  });

  it('matches case-insensitively', async () => {
    writeFileSync(join(dir, 'Poster.JPG'), '');
    const out = await findLocalArtwork(dir);
    expect(out.poster).toBe(join(dir, 'Poster.JPG'));
  });

  it('finds fanart and logo alongside a poster', async () => {
    writeFileSync(join(dir, 'poster.jpg'), '');
    writeFileSync(join(dir, 'backdrop.webp'), '');
    writeFileSync(join(dir, 'clearlogo.png'), '');

    const out = await findLocalArtwork(dir);
    expect(out.poster).toBe(join(dir, 'poster.jpg'));
    expect(out.fanart).toBe(join(dir, 'backdrop.webp'));
    expect(out.logo).toBe(join(dir, 'clearlogo.png'));
  });

  it('finds series folder artwork with no basename', async () => {
    writeFileSync(join(dir, 'folder.jpg'), '');
    writeFileSync(join(dir, 'fanart.jpg'), '');

    const out = await findLocalArtwork(dir);
    expect(out.poster).toBe(join(dir, 'folder.jpg'));
    expect(out.fanart).toBe(join(dir, 'fanart.jpg'));
  });

  it('returns an empty object when nothing matches', async () => {
    writeFileSync(join(dir, 'random.txt'), '');
    expect(await findLocalArtwork(dir)).toEqual({});
  });

  it('returns an empty object when the directory does not exist', async () => {
    expect(await findLocalArtwork(join(dir, 'missing'))).toEqual({});
  });

  it('does not descend into subdirectories', async () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'poster.jpg'), '');
    expect(await findLocalArtwork(dir)).toEqual({});
  });
});
