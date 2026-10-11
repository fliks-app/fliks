import type { DesktopMuteRange } from '../../shared/contract';

export const EDL_AF_LABEL = '@fliksedl';

// Fixed-point, never locale-formatted: a comma would split the mpv filter string.
const num = (n: number): string => String(Math.round(n * 1000) / 1000);

const CHUNK = 100;
// `enable` is evaluated at each audio frame start: widen so a frame straddling an edge is silenced.
const LEAD = 0.05;
const TRAIL = 0.03;

const label = (i: number): string => `${EDL_AF_LABEL}${i}`;

/** mpv `af` entries that silence the given content-time ranges (seconds), chained in
 *  groups of CHUNK terms to keep each expression shallow; [] when there are none. */
export function muteFilters(ranges: readonly DesktopMuteRange[]): string[] {
  const terms = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => `between(t,${num(Math.max(0, r.start - LEAD))},${num(r.end + TRAIL)})`);
  const out: string[] = [];
  for (let i = 0; i < terms.length; i += CHUNK) {
    out.push(`${label(out.length)}:lavfi=[volume=volume=0:enable='${terms.slice(i, i + CHUNK).join('+')}']`);
  }
  return out;
}

/** mpv commands that replace only our labelled filters (`previous` = how many are installed). */
export function muteFilterCommands(
  ranges: readonly DesktopMuteRange[],
  previous: number,
): { commands: string[][]; count: number } {
  const filters = muteFilters(ranges);
  const commands = Array.from({ length: previous }, (_, i) => ['af', 'remove', label(i)]);
  for (const f of filters) commands.push(['af', 'add', f]);
  return { commands, count: filters.length };
}
