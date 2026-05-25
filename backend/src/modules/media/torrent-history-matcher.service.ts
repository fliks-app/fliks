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
 *  2. Exactly one history with normalised `sourceTitle === torrent.name`.
 *  3. Exactly one history whose normalised `sourceTitle` is a prefix of the
 *     normalised `torrent.name` (or vice-versa). Multiple candidates abort.
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
      const byHash = histories.find(
        (h) => h.torrentHash && h.torrentHash.toLowerCase() === hash,
      );
      if (byHash) return { history: byHash, matchedBy: 'hash' };
    }

    const exact = histories.filter(
      (h) => normaliseTorrentName(h.sourceTitle ?? '') === name,
    );
    if (exact.length === 1) {
      return { history: exact[0], matchedBy: 'exact-name' };
    }
    if (exact.length > 1) {
      // Ambiguous exact match — refuse rather than guess.
      this.log.warn(
        `TorrentHistoryMatcher: ${exact.length} histories share normalised sourceTitle="${name}" — refusing to cross-match`,
      );
      return null;
    }

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
