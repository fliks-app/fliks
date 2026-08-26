import { parseReleaseQuality } from './quality.parser';
import { APP_QUALITIES } from '../constants/app-qualities';

/**
 * A resolution above every bucket in `APP_QUALITIES` matched nothing, so the fuzzy list was empty
 * and the last resort returned the table's first entry — WORKPRINT, its lowest rank — as the
 * quality of an 8K file. The label is now corrected without moving the release onto a bucket a
 * profile could allow: mapping 8K to 2160p would let it pass a 4K profile at several times the size.
 */
describe('parseReleaseQuality — a resolution above every known bucket', () => {
  it('VERDICT: no longer labels an 8K release WORKPRINT', () => {
    const { label } = parseReleaseQuality('Show.S01E01.4320p.WEB-DL.x265');
    expect(label).not.toBe(APP_QUALITIES[0].name);
    expect(label).toContain('4320p');
  });

  it('names the nearest known bucket alongside, so the row reads as a quality', () => {
    expect(parseReleaseQuality('Show.S01E01.8K.WEB-DL.x265').label).toContain('2160p');
  });

  it('leaves it off the quality table, so a profile cannot allow it', () => {
    const { quality } = parseReleaseQuality('Show.S01E01.4320p.WEB-DL.x265');
    expect(APP_QUALITIES.some((q) => q.resolution === 4320)).toBe(false);
    // Whatever it resolves to must not be a 2160p bucket, or a 4K profile would accept it.
    expect(quality.resolution).not.toBe(2160);
  });

  it('still labels a known resolution from its own bucket', () => {
    expect(parseReleaseQuality('Show.S01E01.1080p.WEB-DL.x264').label).not.toContain('(');
  });
});
