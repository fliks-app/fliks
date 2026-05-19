/**
 * Rewrite an HLS-fMP4 ISO BMFF buffer so the same `.m4s` / `.mp4` bytes
 * parse on Samsung Tizen AVPlay, Apple HLS AVPlayer, ExoPlayer, Shaka
 * and the Cast receiver alike.
 *
 * FFmpeg's HLS muxer hardcodes `movflags=+frag_custom+dash+delay_moov`
 * into its mp4 sub-muxer (`libavformat/hlsenc.c::hls_mux_init`), so
 * user-supplied `-movflags +cmaf` is silently ignored. Every init
 * segment ships as `ftyp(iso5, compat=iso5 iso6 mp41)` and every media
 * segment ships as `styp(msdh, compat=msdh cmfc) + sidx + moof + mdat`
 * — pure DASH flavour. Tizen AVPlay rejects that flavour with
 * `InvalidAccessError` / `PLAYER_ERROR_CONNECTION_FAILED` (issue #148).
 *
 * The reference shape AVPlay parses cleanly is Apple's own HLS-fMP4
 * (`devstreaming-cdn.apple.com/.../adv_dv_atmos/...`):
 *
 *     init.mp4:  ftyp(iso5,  compat = isom iso5 hlsf) + moov
 *     seg.m4s:   (optional emsg) + moof + mdat        — NO `styp`, NO `sidx`
 *
 * The load-bearing differences vs FFmpeg's output are:
 *   1. `hlsf` ("HLS Fragmented MP4") in the ftyp compat-brand list. This
 *      is the marker Tizen's HLS parser uses to dispatch to the HLS
 *      branch — without it, AVPlay treats the segment as DASH and
 *      rejects it.
 *   2. No top-level `styp` box on media segments. FFmpeg's DASH-flavoured
 *      `styp(msdh)` confuses AVPlay even when `cmfc` is in the compat
 *      list. The box is optional in the HLS-fMP4 profile, so we strip
 *      it entirely.
 *   3. No top-level `sidx`. We were already stripping it for `cmfc`-style
 *      output; same logic, same fix.
 *
 * We deliberately KEEP the `iso5` major brand on `ftyp` — Apple's own
 * reference HLS-fMP4 ships with `iso5` and AVPlay accepts it as long as
 * `hlsf` is in the compat list.
 *
 * The transform is in-place over a single Buffer and runs in linear
 * time. Average segment is 2–3 MB, scan cost is sub-millisecond.
 */

const FOUR_CC_LEN = 4;
const BOX_HEADER_LEN = 8;
const HLSF = Buffer.from('hlsf', 'latin1');

import * as fsp from 'fs/promises';

/** True when the buffer's first top-level box is `ftyp` containing the
 *  `hlsf` compat brand — i.e. the init has already been Apple-flavoured
 *  and a second pass is a no-op. Segments are detected by the absence
 *  of a leading `styp` (we strip it on the first pass), so the same
 *  check works there. */
export function isCmafRewritten(buf: Buffer): boolean {
  if (buf.length < BOX_HEADER_LEN + FOUR_CC_LEN) return false;
  const type = buf.slice(4, 8).toString('latin1');
  if (type === 'styp') return false; // styp still present → not rewritten
  if (type !== 'ftyp') return true; // moof / emsg first → already cleaned
  // Look for `hlsf` in the compat-brand list (offset 16 onward).
  const size = buf.readUInt32BE(0);
  for (let i = 16; i + FOUR_CC_LEN <= Math.min(size, buf.length); i += FOUR_CC_LEN) {
    if (buf.slice(i, i + FOUR_CC_LEN).equals(HLSF)) return true;
  }
  return false;
}

/** Read a segment / init from disk and return the Apple HLS-fMP4 bytes
 *  AVPlay accepts. The caller is expected to pipe the returned Buffer
 *  straight to the HTTP response — we deliberately do NOT write the
 *  rewritten bytes back to disk.
 *
 *  Disk-rewriting is racy with FFmpeg's HLS muxer: the muxer rewrites
 *  `init_<v>.mp4` and the segment files in-place on session restart /
 *  variant restart (no temp_file + rename), so any rewrite we land on
 *  disk gets clobbered by the next FFmpeg flush. The clobber races
 *  against `createReadStream` after `statSync` — the pipe ends up
 *  serving a mix of new-Content-Length header + stale bytes, which the
 *  player treats as a truncated response.
 *
 *  Reading + rewriting + piping from memory takes that race off the
 *  table: we hold the rewritten bytes locally, FFmpeg can overwrite
 *  the disk file as much as it wants, the response we already
 *  committed to is internally consistent. */
export async function readAndRewriteCmaf(
  filePath: string,
): Promise<Buffer | null> {
  let buf: Buffer;
  try {
    buf = await fsp.readFile(filePath);
  } catch {
    return null;
  }
  if (buf.length === 0) return null;
  if (isCmafRewritten(buf)) return buf;
  return cmafRewrite(buf);
}

/** Strip `sidx` and `styp` boxes; append `hlsf` to the ftyp compat-brand
 *  list. Returns a new Buffer. */
export function cmafRewrite(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  while (off + BOX_HEADER_LEN <= buf.length) {
    const size = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');

    // Box-size sentinels:
    //   0 → box extends to EOF (rare in fragmented mp4; pass through).
    //   1 → 64-bit `largesize` follows the type. We don't expect this
    //       on the boxes we rewrite (ftyp/styp/sidx are always small),
    //       so passing through is safe.
    if (size === 0) {
      parts.push(buf.slice(off));
      break;
    }
    if (size === 1) {
      parts.push(buf.slice(off));
      break;
    }
    if (off + size > buf.length) {
      // Truncated box — bail out and copy the rest verbatim. Lets a
      // partial mid-write segment served by mistake degrade gracefully
      // instead of throwing.
      parts.push(buf.slice(off));
      break;
    }

    if (type === 'sidx' || type === 'styp') {
      // Drop the box entirely. `sidx` triggers AVPlay's
      // `InvalidAccessError` in HLS-fMP4 context; `styp` is optional
      // in HLS-fMP4 and FFmpeg writes a DASH-flavoured one (`msdh` +
      // `msix`) that signals a `sidx` follows — leaving it in place
      // contradicts the sidx-stripping and confuses AVPlay. This
      // shape (no styp, no sidx, just `moof`+`mdat`) is what the
      // multi-audio fmp4 path uses in production and what Tizen
      // AVPlay accepts.
      off += size;
      continue;
    }

    if (type === 'ftyp') {
      // Append `hlsf` to the compat-brand list if missing. Keep the
      // `iso5` major brand intact — Apple's reference uses it.
      const boxBuf = buf.slice(off, off + size);
      let hasHlsf = false;
      for (
        let i = 16;
        i + FOUR_CC_LEN <= boxBuf.length;
        i += FOUR_CC_LEN
      ) {
        if (boxBuf.slice(i, i + FOUR_CC_LEN).equals(HLSF)) {
          hasHlsf = true;
          break;
        }
      }
      if (hasHlsf) {
        parts.push(boxBuf);
      } else {
        // Grow the ftyp box by 4 bytes for the new brand. The size field
        // is at offset 0..3 of the box itself.
        const newSize = size + FOUR_CC_LEN;
        const grown = Buffer.alloc(newSize);
        boxBuf.copy(grown, 0);
        HLSF.copy(grown, size);
        grown.writeUInt32BE(newSize, 0);
        parts.push(grown);
      }
      off += size;
      continue;
    }

    parts.push(buf.slice(off, off + size));
    off += size;
  }
  return Buffer.concat(parts);
}
