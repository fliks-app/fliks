import { normalizeChannelName, nameSimilarity } from './channel-name';
import type { GuideMatchKind } from '../entities/livetv-channel.entity';

export interface GuideCandidate {
  id: string;
  displayNames: string[];
}

export interface MatchableChannel {
  id: number;
  name: string;
  guideChannelId: string | null;
  guideMatchKind: GuideMatchKind | null;
}

export interface GuideAssignment {
  channelId: number;
  guideChannelId: string;
  kind: Exclude<GuideMatchKind, 'manual'>;
}

export interface GuideMatchReport {
  assignments: GuideAssignment[];
  unmatchedChannelIds: number[];
  byKind: Record<Exclude<GuideMatchKind, 'manual'>, number>;
}

/** Below this, a name pair is a coincidence rather than the same channel. */
const FUZZY_THRESHOLD = 0.75;

/**
 * Three passes, weakest last, each recorded so the admin sees what to trust:
 * the guide id the provider already agreed on, then the name, then a token
 * overlap. A manual assignment is never revisited.
 */
export function matchGuideChannels(
  channels: readonly MatchableChannel[],
  candidates: readonly GuideCandidate[],
): GuideMatchReport {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const candidate of candidates) {
    byId.set(candidate.id.toLowerCase(), candidate.id);
    for (const name of [candidate.id, ...candidate.displayNames]) {
      const key = normalizeChannelName(name);
      // First feed entry wins: a later duplicate is the ambiguous one.
      if (key && !byName.has(key)) byName.set(key, candidate.id);
    }
  }

  const assignments: GuideAssignment[] = [];
  const unmatchedChannelIds: number[] = [];
  const byKind = { id: 0, name: 0, fuzzy: 0 };

  for (const channel of channels) {
    if (channel.guideMatchKind === 'manual') continue;

    const exact = channel.guideChannelId
      ? byId.get(channel.guideChannelId.toLowerCase())
      : undefined;
    if (exact) {
      assignments.push({ channelId: channel.id, guideChannelId: exact, kind: 'id' });
      byKind.id++;
      continue;
    }

    const named = byName.get(normalizeChannelName(channel.name));
    if (named) {
      assignments.push({
        channelId: channel.id,
        guideChannelId: named,
        kind: 'name',
      });
      byKind.name++;
      continue;
    }

    let best: { id: string; score: number } | null = null;
    for (const candidate of candidates) {
      for (const name of candidate.displayNames) {
        const score = nameSimilarity(channel.name, name);
        if (score > (best?.score ?? 0)) best = { id: candidate.id, score };
      }
    }
    if (best && best.score >= FUZZY_THRESHOLD) {
      assignments.push({
        channelId: channel.id,
        guideChannelId: best.id,
        kind: 'fuzzy',
      });
      byKind.fuzzy++;
    } else {
      unmatchedChannelIds.push(channel.id);
    }
  }

  return { assignments, unmatchedChannelIds, byKind };
}

export interface PrioritizedRow {
  guideChannelId: string;
  guideSourceId: number;
}

/**
 * Resolves guide-source collisions, not channel matching: two mainstream XMLTV
 * namespaces share under 5% of their channel ids, so two feeds legitimately
 * defining the same id is normal. The higher-priority source wins outright for
 * that channel id; rows are never interleaved between sources. Ties go to the
 * lower source id, so the result is deterministic.
 */
export function pickHighestPriorityRows<T extends PrioritizedRow>(
  rows: readonly T[],
  priorityBySourceId: ReadonlyMap<number, number>,
): T[] {
  const winnerSource = new Map<string, number>();
  const winnerPriority = new Map<string, number>();
  for (const row of rows) {
    const priority = priorityBySourceId.get(row.guideSourceId) ?? 0;
    const currentSource = winnerSource.get(row.guideChannelId);
    const currentPriority = winnerPriority.get(row.guideChannelId);
    if (
      currentSource === undefined ||
      priority > currentPriority! ||
      (priority === currentPriority && row.guideSourceId < currentSource)
    ) {
      winnerSource.set(row.guideChannelId, row.guideSourceId);
      winnerPriority.set(row.guideChannelId, priority);
    }
  }
  return rows.filter((row) => winnerSource.get(row.guideChannelId) === row.guideSourceId);
}
