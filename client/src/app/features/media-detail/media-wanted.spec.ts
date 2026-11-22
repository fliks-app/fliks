import { describe, expect, it } from 'vitest';
import type { Media } from '../../core/services/api/media.service';
import { isWanted } from './media-wanted';

const base = { id: 1, monitored: true, files: [] } as unknown as Media;
const as = (extra: object) => ({ ...base, ...extra }) as unknown as Media;

describe('isWanted', () => {
  it('waits for a file of a monitored movie that has none', () => {
    expect(isWanted(as({ type: 'movie' }))).toBe(true);
    expect(isWanted(as({ type: 'movie', files: [{ id: 1 }] }))).toBe(false);
    expect(isWanted(as({ type: 'movie', monitored: false }))).toBe(false);
  });

  it('waits for the missing episodes of a series', () => {
    expect(isWanted(as({ type: 'series', episodeStats: { totalEpisodes: 3, downloadedEpisodes: 2 } }))).toBe(true);
    expect(isWanted(as({ type: 'series', episodeStats: { totalEpisodes: 3, downloadedEpisodes: 3 } }))).toBe(false);
  });

  it('waits for a wanted track without a file on an album', () => {
    const album = (tracks: object[]) => as({ type: 'album', album: { tracks } });
    expect(isWanted(album([{ monitored: true, hasFile: false }]))).toBe(true);
    expect(isWanted(album([{ monitored: true, hasFile: true }, { monitored: false, hasFile: false }]))).toBe(false);
  });

  it('waits for a book or comic with no file at all', () => {
    expect(isWanted(as({ type: 'book', book: { editions: [{ hasFile: false }] } }))).toBe(true);
    expect(isWanted(as({ type: 'book', book: { editions: [{ hasFile: true }] } }))).toBe(false);
    expect(isWanted(as({ type: 'comic', comic: { issues: [{ mediaFileId: null }] } }))).toBe(true);
    expect(isWanted(as({ type: 'comic', comic: { issues: [{ mediaFileId: 3 }] } }))).toBe(false);
  });
});
