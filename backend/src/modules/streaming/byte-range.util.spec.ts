import { parseByteRange } from './byte-range.util';

describe('parseByteRange', () => {
  const SIZE = 1000; // bytes 0..999

  it('parses a normal closed range', () => {
    expect(parseByteRange('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=200-499', SIZE)).toEqual({
      start: 200,
      end: 499,
    });
  });

  it('parses an open-ended range to EOF', () => {
    expect(parseByteRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseByteRange('bytes=-500', SIZE)).toEqual({ start: 500, end: 999 });
  });

  it('clamps a suffix larger than the file to the whole file', () => {
    expect(parseByteRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end past EOF to the last byte', () => {
    expect(parseByteRange('bytes=0-99999', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('honours only the first range of a multi-range request', () => {
    expect(parseByteRange('bytes=0-99,200-299', SIZE)).toEqual({
      start: 0,
      end: 99,
    });
  });

  it('tolerates whitespace', () => {
    expect(parseByteRange('bytes= 10 - 20 ', SIZE)).toEqual({
      start: 10,
      end: 20,
    });
  });

  it.each([
    ['start > end', 'bytes=5-1'],
    ['start at EOF', 'bytes=1000-'],
    ['start past EOF', 'bytes=1500-1600'],
    ['non-numeric start', 'bytes=abc-'],
    ['non-numeric end', 'bytes=0-xyz'],
    ['non-numeric suffix', 'bytes=-abc'],
    ['zero suffix', 'bytes=-0'],
    ['empty', 'bytes='],
    ['no dash', 'bytes=100'],
    ['bare empty range', 'bytes=-'],
  ])('returns null (→ 416) for %s', (_label, header) => {
    expect(parseByteRange(header, SIZE)).toBeNull();
  });

  it('returns null for any range against a zero-byte file', () => {
    expect(parseByteRange('bytes=0-', 0)).toBeNull();
  });
});
