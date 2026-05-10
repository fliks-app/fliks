import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DownloadHistory } from './entities/download-history.entity';

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
 *  2. Exactly one history with `sourceTitle === torrent.name`.
 *  3. Exactly one history whose `sourceTitle` is a prefix of `torrent.name`
 *     (or vice-versa). Multiple candidates abort instead of cross-matching.
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
    const name = torrent.name.toLowerCase();

    if (hash) {
      const byHash = histories.find(
        (h) => h.torrentHash && h.torrentHash.toLowerCase() === hash,
      );
      if (byHash) return { history: byHash, matchedBy: 'hash' };
    }

    const exact = histories.filter(
      (h) => h.sourceTitle?.toLowerCase() === name,
    );
    if (exact.length === 1) {
      return { history: exact[0], matchedBy: 'exact-name' };
    }
    if (exact.length > 1) {
      // Ambiguous exact match — refuse rather than guess.
      this.log.warn(
        `TorrentHistoryMatcher: ${exact.length} histories share sourceTitle="${torrent.name}" — refusing to cross-match`,
      );
      return null;
    }

    const prefix = histories.filter((h) => {
      if (!h.sourceTitle) return false;
      const s = h.sourceTitle.toLowerCase();
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
