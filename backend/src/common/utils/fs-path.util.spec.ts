import { sanitizeFsPath } from './fs-path.util';

const LRE = String.fromCodePoint(0x202a); // Explorer "Copy as path" prefix
const PDF = String.fromCodePoint(0x202c);
const BOM = String.fromCodePoint(0xfeff);

describe('sanitizeFsPath', () => {
  it('strips a leading LEFT-TO-RIGHT EMBEDDING so the path stays absolute', () => {
    expect(sanitizeFsPath(`${LRE}C:\\Users\\Paul\\Downloads`)).toBe(
      'C:\\Users\\Paul\\Downloads',
    );
  });

  it('strips wrapping bidi marks and the BOM', () => {
    expect(sanitizeFsPath(`${BOM}${LRE}/mnt/media${PDF}`)).toBe('/mnt/media');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeFsPath('  /mnt/media  ')).toBe('/mnt/media');
  });

  it('leaves a clean path untouched', () => {
    expect(sanitizeFsPath('D:\\Videos')).toBe('D:\\Videos');
  });
});
