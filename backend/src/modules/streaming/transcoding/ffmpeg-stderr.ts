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
 */
const BENIGN_STDERR_PATTERNS: RegExp[] = [
  /Could not find codec parameters for stream \d+ \(Subtitle:/,
  /Consider increasing the value for the 'analyzeduration'/,
];

/** Strip {@link BENIGN_STDERR_PATTERNS} from a captured ffmpeg stderr blob so
 *  the logged tail carries only actionable output. Pure string transform. */
export function stripBenignFfmpegStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !BENIGN_STDERR_PATTERNS.some((re) => re.test(line)))
    .join('\n');
}
