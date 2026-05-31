/**
 * Parse a single HTTP `Range` header against a known file size (RFC 7233).
 *
 * Returns the resolved `[start, end]` (inclusive, clamped to the file) for a
 * satisfiable range, or `null` when the range is unsatisfiable / malformed —
 * the caller answers `null` with `416 Range Not Satisfiable`
 * (`Content-Range: bytes *​/<size>`). Only the first range of a (rare)
 * multi-range request is honoured, matching the single-stream response the
 * direct-play endpoint produces.
 *
 * Handles the forms the previous bare `parseInt` split mishandled:
 *  - `bytes=S-E`   normal range; `E` clamped to the last byte
 *  - `bytes=S-`    open-ended; serves S..EOF
 *  - `bytes=-N`    suffix; serves the last N bytes (N>file → whole file)
 *  - garbage / `start>end` / `start>=size` / negative → `null` (→ 416)
 */
export function parseByteRange(
  rangeHeader: string,
  fileSize: number,
): { start: number; end: number } | null {
  const spec = (rangeHeader.replace(/^bytes=/, '').split(',')[0] ?? '').trim();
  const dash = spec.indexOf('-');
  if (dash < 0) return null;

  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();

  // Suffix range: `bytes=-N` → last N bytes.
  if (startStr === '') {
    const n = Number(endStr);
    if (!Number.isInteger(n) || n <= 0) return null;
    return { start: Math.max(0, fileSize - n), end: Math.max(0, fileSize - 1) };
  }

  const start = Number(startStr);
  if (!Number.isInteger(start) || start < 0 || start >= fileSize) return null;

  let end = endStr === '' ? fileSize - 1 : Number(endStr);
  if (!Number.isInteger(end)) return null;
  end = Math.min(end, fileSize - 1);
  if (end < start) return null;

  return { start, end };
}
