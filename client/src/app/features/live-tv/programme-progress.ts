import { LiveProgram } from '../../core/services/api/livetv-api.service';

/** How far into the programme we are, as a percentage. Read from the wall clock
 *  rather than the playhead: it describes the broadcast, not the viewer. */
export function programmeProgressPercent(program: LiveProgram | null | undefined): number {
  if (!program) return 0;
  const start = new Date(program.startsAt).getTime();
  const end = new Date(program.endsAt).getTime();
  if (!(end > start)) return 0;
  return Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
}
