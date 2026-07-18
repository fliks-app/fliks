/** Benign ffmpeg stderr lines dropped before a transcode's stderr tail is
 *  logged. They clutter diagnostics — and make a real failure harder to read —
 *  without signalling a fault:
 *
 *   - Image-subtitle streams (PGS / VOBSUB) we never map report
 *     `Could not find codec parameters for stream N (Subtitle: …): unspecified
 *     size` under the fast-start `-analyzeduration 0` probe. The streams aren't
 *     in the output map, so the transcode is unaffected.
 *   - ffmpeg's paired `Consider increasing the value for the 'analyzeduration'`
 *     hint isn't actionable: the low probe budget is a deliberate first-segment
 *     latency choice, not an oversight.
 *   - The OpenCL device enumeration reports `QSV to OpenCL mapping not usable`
 *     (needs the Linux-only `cl_intel_va_api_media_sharing` extension) on the
 *     Windows QSV OpenCL path. That zero-copy map is unused — the tone-map
 *     bounces through the CPU (`hwupload`) — so it's informational only.
 */
const BENIGN_STDERR_PATTERNS: RegExp[] = [
  /Could not find codec parameters for stream \d+ \(Subtitle:/,
  /Consider increasing the value for the 'analyzeduration'/,
  /QSV to OpenCL mapping not usable/,
  /cl_intel_va_api_media_sharing extension is required/,
];

/** Strip {@link BENIGN_STDERR_PATTERNS} from a captured ffmpeg stderr blob so
 *  the logged tail carries only actionable output. Pure string transform. */
export function stripBenignFfmpegStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !BENIGN_STDERR_PATTERNS.some((re) => re.test(line)))
    .join('\n');
}

/** ffmpeg stderr lines that signal a timestamp anomaly rather than a crash.
 *  They appear on an exit-0 process during normal playback — where nothing
 *  logs the stderr tail — so an A/V-desync incident leaves no trace. Each maps
 *  to a stable label so the caller can surface the first occurrence per session
 *  once, instead of on every chunk. */
const TIMING_STDERR_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'non-monotonic-dts', re: /Non-monoton(?:ic|ous) DTS/i },
  {
    label: 'invalid-increasing-dts',
    re: /non[- ]monotonically increasing dts/i,
  },
  { label: 'past-duration-too-large', re: /Past duration [\d.]+ too large/i },
  { label: 'backward-in-time', re: /is backward in time/i },
];

/** Scan an ffmpeg stderr fragment for timestamp-anomaly lines. Returns at most
 *  one `{ label, line }` per distinct anomaly kind found, so a caller keeping a
 *  seen-set logs each kind once per session. Pure — the throttling state lives
 *  with the caller. */
export function matchTimingWarnings(
  text: string,
): { label: string; line: string }[] {
  const out: { label: string; line: string }[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    for (const { label, re } of TIMING_STDERR_PATTERNS) {
      if (!seen.has(label) && re.test(line)) {
        seen.add(label);
        out.push({ label, line: line.trim() });
      }
    }
  }
  return out;
}

/** Number of distinct timing-anomaly kinds — the caller can stop scanning once
 *  it has surfaced them all. */
export const TIMING_WARNING_KINDS = TIMING_STDERR_PATTERNS.length;
