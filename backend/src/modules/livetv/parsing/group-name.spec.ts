import { normalizeGroupName, UNGROUPED_SENTINEL } from './group-name';

describe('normalizeGroupName', () => {
  it('trims edge whitespace an IPTV playlist commonly carries', () => {
    expect(normalizeGroupName('XXX ')).toBe('XXX');
    expect(normalizeGroupName('  News')).toBe('News');
  });

  it.each([null, undefined, '', '   '])(
    'replaces %j with the ungrouped sentinel',
    (raw) => {
      expect(normalizeGroupName(raw)).toBe(UNGROUPED_SENTINEL);
    },
  );

  it('leaves internal spacing and case alone', () => {
    expect(normalizeGroupName(' News  FR ')).toBe('News  FR');
  });
});
