import * as zlib from 'zlib';

/**
 * Extract the first .srt (or .ass/.ssa/.sub) file from a ZIP buffer.
 * Minimal ZIP parsing — no external dependency needed.
 */
export function extractSubtitleFromZip(zip: Buffer): Buffer {
  let offset = 0;
  while (offset + 30 <= zip.length) {
    const sig = zip.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // not a local file header

    const compMethod = zip.readUInt16LE(offset + 8);
    const compSize = zip.readUInt32LE(offset + 18);
    const uncompSize = zip.readUInt32LE(offset + 22);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const name = zip
      .subarray(offset + 30, offset + 30 + nameLen)
      .toString('utf-8');
    const dataStart = offset + 30 + nameLen + extraLen;

    if (/\.(srt|ass|ssa|sub|vtt)$/i.test(name)) {
      if (compMethod === 0) {
        return zip.subarray(dataStart, dataStart + uncompSize);
      }
      if (compMethod === 8) {
        return zlib.inflateRawSync(
          zip.subarray(dataStart, dataStart + compSize),
        );
      }
    }

    offset = dataStart + compSize;
  }

  throw new Error('No subtitle file found in ZIP archive');
}
