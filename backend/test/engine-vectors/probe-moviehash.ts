import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeMovieHash } from '../../src/modules/subtitles/moviehash';

const CHUNK = 65536;

/** Content of a synthetic file: a function of the absolute offset, so head and tail are reproducible. */
export const byteAt = (o: number): number =>
  ((o % 251) + (Math.floor(o / 251) % 241) * 3 + 17) & 0xff;

/** OpenSubtitles hash as specified: 64-bit sum of size and the first and last 64 KiB. */
function reference(size: number): string {
  let sum = BigInt(size);
  const add = (from: number) => {
    for (let o = from; o < from + CHUNK; o += 8) {
      let w = 0n;
      for (let i = 7; i >= 0; i--) w = (w << 8n) | BigInt(byteAt(o + i));
      sum = (sum + w) & 0xffffffffffffffffn;
    }
  };
  add(0);
  add(size - CHUNK);
  return sum.toString(16).padStart(16, '0');
}

const SIZES = [
  131071, // under two chunks
  131072,
  200000,
  1_000_003,
  2_147_483_647, // 2^31 - 1: low word still below the sign bit
  2_147_483_648, // 2^31: the host's `& 0xffffffff` turns negative
  3_000_000_000,
  4_294_967_295,
  4_294_967_296 + 5,
  4_294_967_296 + 3_000_000_000,
  10 * 1024 ** 3 + 12345,
];

/** The host's hash of sparse files of `SIZES`, next to the specified one. */
export async function moviehashVectors() {
  const dir = mkdtempSync(join(tmpdir(), 'moviehash-'));
  try {
    const out = [];
    for (const size of SIZES) {
      const path = join(dir, `f${size}`);
      const fd = openSync(path, 'w');
      truncateSync(path, size);
      for (const from of size < CHUNK * 2 ? [0] : [0, size - CHUNK]) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - from));
        for (let i = 0; i < buf.length; i++) buf[i] = byteAt(from + i);
        writeSync(fd, buf, 0, buf.length, from);
      }
      closeSync(fd);
      const host = await computeMovieHash(path);
      rmSync(path);
      out.push({
        size,
        host: host?.hash ?? null,
        reference: size < CHUNK * 2 ? null : reference(size),
      });
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
