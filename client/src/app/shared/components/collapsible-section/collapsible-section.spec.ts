import { readSectionOpen, writeSectionOpen } from './collapsible-section';

describe('collapsible section persistence', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to the default until something is stored', () => {
    expect(readSectionOpen('cast', true)).toBe(true);
    expect(readSectionOpen('cast', false)).toBe(false);
  });

  it('reads back both states, default be damned', () => {
    writeSectionOpen('cast', false);
    expect(readSectionOpen('cast', true)).toBe(false);
    writeSectionOpen('cast', true);
    expect(readSectionOpen('cast', false)).toBe(true);
  });

  it('keeps sections independent and skips storage without a key', () => {
    writeSectionOpen('cast', false);
    expect(readSectionOpen('fileInfo', true)).toBe(true);
    writeSectionOpen('', false);
    expect(readSectionOpen('', true)).toBe(true);
  });
});
