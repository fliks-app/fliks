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
