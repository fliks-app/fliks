import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DownloadHistory } from './entities/download-history.entity';
import { decodeHtmlEntities } from '../../common/utils/decode-html-entities';

/** A subset of `QbittorrentTorrent` — all the matcher actually needs. */
export interface MatchableTorrent {
  hash?: string | null;
  name: string;
}

export type MatchedBy = 'hash' | 'exact-name' | 'unique-prefix';

export interface HistoryMatch {
  history: DownloadHistory;
  matchedBy: MatchedBy;
}

const LIVE_STATUSES = new Set(['grabbed', 'importing']);

/**
 * Several rows legitimately describe one torrent: re-grabbing a release already
 * in the client adds a row but no torrent, since qBittorrent deduplicates by
 * hash. Ranking them is therefore mandatory — without it the winner is whatever
 * order the database happened to return, and callers disagree on which row
 * speaks for the torrent.
 */
function authorityRank(h: DownloadHistory): number {
  return (h.mediaId ? 2 : 0) + (LIVE_STATUSES.has(h.status) ? 1 : 0);
}

/** Whether `candidate` speaks for the torrent over `current`: a media link
 *  first, then a live status over a terminal one, then the most recent row. */
export function outranksForTorrent(
  candidate: DownloadHistory,
  current: DownloadHistory,
): boolean {
  const delta = authorityRank(candidate) - authorityRank(current);
  return delta > 0 || (delta === 0 && candidate.id > current.id);
}

function pickAuthoritative(rows: DownloadHistory[]): DownloadHistory | null {
  let best: DownloadHistory | null = null;
  for (const h of rows) {
    if (!best || outranksForTorrent(h, best)) best = h;
  }
  return best;
}

/**
 * Single source of truth for the "which DownloadHistory does this qBittorrent
 * torrent belong to" lookup. Three call sites used to inline three slightly
 * different versions: `CompletionService.processCompleted`, the orphan-purge
 * preamble inside it, and `DownloadClientsService.getQueue`. Each had its
 * own bugs around `startsWith` cross-matching and none persisted the
 * recovered `torrentHash` back onto the history row — so legacy auto-grabs
 * (pre-PR-#82) without a hash stayed unmatched at every tick, surfacing in
 * the Activities view as "downloads not linked to a media".
 *
 * Rules, in order:
 *  1. `history.torrentHash === torrent.hash` — definitive.
 *  2. Histories whose normalised `sourceTitle` equals the normalised
 *     `torrent.name` — the same release.
 *  3. Exactly one history whose normalised `sourceTitle` is a prefix of the
 *     normalised `torrent.name` (or vice-versa). Multiple candidates abort.
 *
 * (1) and (2) can each yield several rows, which {@link outranksForTorrent}
 * ranks. (3) cannot: distinct releases overlap by prefix, so it still aborts.
 *
 * Both name comparisons use {@link normaliseTorrentName}, which decodes HTML
 * entities, collapses whitespace and strips noise tokens — qBittorrent
 * decodes `&amp;`, `&#39;` etc. in the displayed name while the indexer's
 * raw title (which we stored as `sourceTitle`) keeps them, and that drift
 * alone used to orphan otherwise-perfectly-linked rows.
 *
 * On (2) and (3) the matched history's `torrentHash` is filled in if it
 * was null — self-healing legacy data without requiring a migration.
 */
@Injectable()
export class TorrentHistoryMatcher {
  private readonly log = new Logger(TorrentHistoryMatcher.name);

  constructor(
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
  ) {}

  findMatch(
    torrent: MatchableTorrent,
    histories: DownloadHistory[],
  ): HistoryMatch | null {
    const hash = torrent.hash?.toLowerCase() ?? null;
    const name = normaliseTorrentName(torrent.name);

    if (hash) {
      const byHash = pickAuthoritative(
        histories.filter(
          (h) => h.torrentHash && h.torrentHash.toLowerCase() === hash,
        ),
      );
      if (byHash) return { history: byHash, matchedBy: 'hash' };
    }

    // Rows sharing a normalised sourceTitle describe the same release, so rank
    // them like a shared hash. Prefix overlap below stays a refusal: distinct
    // releases can overlap there, and picking one would cross-match them.
    const byName = pickAuthoritative(
      histories.filter(
        (h) => normaliseTorrentName(h.sourceTitle ?? '') === name,
      ),
    );
    if (byName) return { history: byName, matchedBy: 'exact-name' };

    const prefix = histories.filter((h) => {
      if (!h.sourceTitle) return false;
      const s = normaliseTorrentName(h.sourceTitle);
      if (!s) return false;
      return name.startsWith(s) || s.startsWith(name);
    });
    if (prefix.length === 1) {
      return { history: prefix[0], matchedBy: 'unique-prefix' };
    }
    if (prefix.length > 1) {
      this.log.warn(
        `TorrentHistoryMatcher: ${prefix.length} histories with prefix overlap on "${torrent.name}" — skipped`,
      );
    }
    return null;
  }

  /**
   * Persist the torrent hash on a history row when the matcher resolved it
   * by name. Cheap idempotent UPDATE — safe to call on every match.
   */
  async healHash(history: DownloadHistory, hash: string): Promise<void> {
    if (!hash || history.torrentHash) return;
    await this.historyRepo.update(history.id, { torrentHash: hash });
    history.torrentHash = hash;
    this.log.log(
      `TorrentHistoryMatcher: healed torrentHash=${hash} on history #${history.id} ("${history.sourceTitle}")`,
    );
  }

  /**
   * Convenience: match + self-heal in one call. Returns the history row or
   * null. Use when the caller can't easily distinguish "hash" vs "name"
   * matches itself.
   */
  async matchAndHeal(
    torrent: MatchableTorrent,
    histories: DownloadHistory[],
  ): Promise<DownloadHistory | null> {
    const match = this.findMatch(torrent, histories);
    if (!match) return null;
    if (match.matchedBy !== 'hash' && torrent.hash) {
      await this.healHash(match.history, torrent.hash.toLowerCase());
    }
    return match.history;
  }
}

/**
 * Tolerant normalisation for the "is this the same release?" comparison:
 *  - HTML entities decoded via the shared Latin-1 + numeric decoder
 *    (handles `&amp;`, `&iacute;`, `&#39;`, `&#x27;` …). qBittorrent
 *    decodes entities on display while the indexer's raw title (stored
 *    as `sourceTitle`) keeps them, and a single character drift used to
 *    send a row into the orphan pile and ultimately into
 *    `historyRepo.remove` once the orphan-cleanup tick fired.
 *  - Trailing `.torrent` stripped.
 *  - `.`, `_`, multi-space all collapsed to single spaces so
 *    `Show.S01E01-GROUP` matches `Show S01E01 GROUP`.
 *  - Lowercased.
 */
export function normaliseTorrentName(raw: string): string {
  if (!raw) return '';
  let s = decodeHtmlEntities(raw);
  s = s.replace(/\.torrent$/i, '');
  s = s.replace(/[._\s]+/g, ' ').trim();
  return s.toLowerCase();
}
