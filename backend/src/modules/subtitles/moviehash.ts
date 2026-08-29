import * as fs from 'fs/promises';

const HASH_CHUNK_SIZE = 65536; // 64 KiB

/**
 * Compute OpenSubtitles moviehash for a video file.
 * Algorithm: sum of first 64KiB + last 64KiB (as uint64 little-endian words) + filesize.
 * Returns { hash, bytesize } or null if file is too small or unreadable.
 *
 * Async: the tail read is a real seek on a multi-GB file, once per file of a
 * rescan — sync reads would hold the event loop for the whole run.
 */
export async function computeMovieHash(
  filePath: string,
): Promise<{ hash: string; bytesize: number } | null> {
  let fd: fs.FileHandle;
  try {
    fd = await fs.open(filePath, 'r');
  } catch {
    return null;
  }

  try {
    const stat = await fd.stat();
    const bytesize = stat.size;

    if (bytesize < HASH_CHUNK_SIZE * 2) return null;

    const buf = Buffer.alloc(HASH_CHUNK_SIZE * 2);

    // Read first 64 KiB
    await fd.read(buf, 0, HASH_CHUNK_SIZE, 0);
    // Read last 64 KiB
    await fd.read(
      buf,
      HASH_CHUNK_SIZE,
      HASH_CHUNK_SIZE,
      bytesize - HASH_CHUNK_SIZE,
    );

    // Sum as uint64 little-endian words + filesize
    let lo = 0;
    let hi = 0;

    // Add filesize
    lo += bytesize & 0xffffffff;
    hi += Math.floor(bytesize / 0x100000000);

    for (let i = 0; i < buf.length; i += 8) {
      lo += buf.readUInt32LE(i);
      hi += buf.readUInt32LE(i + 4);
      // Carry
      hi += Math.floor(lo / 0x100000000);
      lo = lo >>> 0;
      hi = hi >>> 0;
    }

    lo = lo >>> 0;
    hi = hi >>> 0;

    const hash =
      hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');

    return { hash, bytesize };
  } finally {
    await fd.close();
  }
}
