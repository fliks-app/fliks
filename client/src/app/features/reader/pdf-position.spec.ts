import { pdfPageOf, pdfProgression } from './pdf-position';

describe('pdf position', () => {
  it('maps pages to 0..1, the last page finishing the book', () => {
    expect(pdfProgression(1, 10)).toBe(0);
    expect(pdfProgression(10, 10)).toBe(1);
    expect(pdfProgression(1, 1)).toBe(1);
  });

  it('reads a stored page and clamps it to the document', () => {
    expect(pdfPageOf({ page: 4 }, 10)).toBe(4);
    expect(pdfPageOf({ page: 99 }, 10)).toBe(10);
    expect(pdfPageOf({ page: 0 }, 10)).toBe(1);
    expect(pdfPageOf({ page: '4' }, 10)).toBe(1);
    expect(pdfPageOf(null, 10)).toBe(1);
  });
});
