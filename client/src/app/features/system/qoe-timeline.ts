import type { QoeEventRow, QoeSessionRow } from '../../core/services/api/qoe-api.service';

export type TransitionKind = 'quality_switch' | 'recovery' | 'reload' | 'handoff' | 'next';

/** A rung as the admin names it: `auto` (the server chose) or a rung such as 2160p. */
export interface RungName {
  auto: boolean;
  /** The rung actually served, null when it could not be determined. */
  rung: string | null;
}

export interface TimelineTransition {
  kind: TransitionKind;
  event: QoeEventRow | null;
  from: RungName | null;
  to: RungName | null;
  fromBitrate: number | null;
  toBitrate: number | null;
}

export interface TimelineBlock {
  session: QoeSessionRow;
  first: boolean;
  /** The session's events, minus the one that links it to the next session. */
  events: QoeEventRow[];
}

export interface Timeline {
  blocks: TimelineBlock[];
  /** `transitions[i]` sits between `blocks[i]` and `blocks[i + 1]`. */
  transitions: TimelineTransition[];
}

const served = (s: QoeSessionRow) => s.pipeline?.output?.quality?.replace(/-hdr$/, '') || null;

/** What a session asked for and what it got; `auto` is never presented as a rung. */
export function rungOf(s: QoeSessionRow): RungName {
  const req = s.quality ?? s.pipeline?.output?.requested ?? null;
  const rung = served(s);
  if (req === 'auto' || (!req && s.pipeline?.output?.requested === 'auto')) return { auto: true, rung: rung && rung !== 'auto' ? rung : null };
  return { auto: false, rung: rung && rung !== 'auto' ? rung : req };
}

const LINKS = new Set(['quality_switch', 'recovery', 'reload']);

/**
 * One chronological timeline grouped by session. Sessions of a playback follow each other, never overlap, and every
 * event carries its sessionId; the event that caused the next session (a quality switch or a recovery recorded on the
 * old sid) becomes the transition between the two blocks instead of a line in the first.
 */
export function buildTimeline(sessions: QoeSessionRow[], events: QoeEventRow[]): Timeline {
  const blocks: TimelineBlock[] = sessions.map((session, i) => ({ session, first: i === 0, events: [] }));
  if (!blocks.length) return { blocks, transitions: [] };
  const byId = new Map(blocks.map((b) => [b.session.sessionId, b]));
  for (const e of events) (byId.get(e.sessionId ?? '') ?? blocks[blocks.length - 1]).events.push(e);

  const transitions: TimelineTransition[] = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    const cur = blocks[i];
    const next = blocks[i + 1];
    const link = [...cur.events].reverse().find((e) => LINKS.has(e.type)) ?? null;
    if (link) cur.events.splice(cur.events.indexOf(link), 1);
    const kind: TransitionKind = link
      ? (link.type as TransitionKind)
      : next.session.engine === 'cast' && cur.session.engine !== 'cast'
        ? 'handoff'
        : 'next';
    transitions.push({
      kind,
      event: link,
      from: rungOf(cur.session),
      to: rungOf(next.session),
      fromBitrate: link?.data?.fromBitrate ?? null,
      toBitrate: link?.data?.toBitrate ?? null,
    });
  }
  return { blocks, transitions };
}

/** A playback still running: not ended, and seen recently. */
export function isOngoing(d: Pick<QoeSessionRow, 'endedAt' | 'lastSeenAt'>, now = Date.now()): boolean {
  return d.endedAt == null && now - new Date(d.lastSeenAt).getTime() < 120_000;
}
