import { CompletionService } from './completion.service';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { QbittorrentTorrent } from '../download-clients/qbittorrent.service';
import { TorrentHistoryMatcher } from '../media/torrent-history-matcher.service';

/** The exact stamp the orphan sweep writes — pinned here so the test guards
 *  the user-visible string the queue clears and re-applies. */
const ORPHAN_MESSAGE = 'Torrent no longer present in download client';

/**
 * `reconcileOrphanHistory` is private and only touches `historyRepo`,
 * `historyMatcher` and `log`, so we exercise it on a bare prototype instance
 * rather than standing up the 27-dependency constructor.
 */
function buildService(matchByHash: Set<string>) {
  const update = jest.fn().mockResolvedValue(undefined);
  const emit = jest.fn();
  const service = Object.create(CompletionService.prototype) as CompletionService;

  const matcher = {
    findMatch: (t: QbittorrentTorrent, histories: DownloadHistory[]) => {
      if (!t.hash || !matchByHash.has(t.hash)) return null;
      const history = histories.find((h) => h.torrentHash === t.hash);
      return history ? { history, matchedBy: 'hash' as const } : null;
    },
  } as unknown as TorrentHistoryMatcher;

  // Assign the few collaborators the method touches onto the bare instance.
  // Cast away `private readonly` since there's no constructor to set them.
  const wired = service as unknown as {
    historyRepo: unknown;
    historyMatcher: unknown;
    log: unknown;
    events: unknown;
  };
  wired.historyRepo = { update };
  wired.historyMatcher = matcher;
  wired.log = { warn: jest.fn(), log: jest.fn() };
  wired.events = { emit };
  return { service, update, emit };
}

function torrent(hash: string): QbittorrentTorrent {
  return { hash, name: hash, state: 'metaDL' } as QbittorrentTorrent;
}

function history(over: Partial<DownloadHistory>): DownloadHistory {
  return {
    id: 1,
    status: 'grabbed',
    torrentHash: 'h1',
    sourceTitle: 'h1',
    statusMessage: null as unknown as string,
    updatedAt: new Date(),
    ...over,
  } as DownloadHistory;
}

const HOUR_AGO = new Date(Date.now() - 60 * 60_000);

describe('CompletionService.reconcileOrphanHistory', () => {
  function run(
    torrents: QbittorrentTorrent[],
    rows: DownloadHistory[],
    importingRows: DownloadHistory[] = [],
  ) {
    const present = new Set(torrents.map((t) => t.hash));
    const { service, update, emit } = buildService(present);
    return {
      update,
      emit,
      done: (
        service as unknown as {
          reconcileOrphanHistory: (
            t: QbittorrentTorrent[],
            g: DownloadHistory[],
            i: DownloadHistory[],
          ) => Promise<void>;
        }
      ).reconcileOrphanHistory(torrents, rows, importingRows),
    };
  }

  it('flips a grabbed row to failed once its torrent is gone past the grace', async () => {
    const row = history({ id: 7, status: 'grabbed', updatedAt: HOUR_AGO });
    const { update, done } = run([], [row]);
    await done;
    expect(update).toHaveBeenCalledWith([7], {
      status: 'failed',
      statusMessage: ORPHAN_MESSAGE,
    });
  });

  it('leaves a grabbed row alone while its torrent is still present', async () => {
    const row = history({ id: 7, status: 'grabbed', updatedAt: HOUR_AGO });
    const { update, done } = run([torrent('h1')], [row]);
    await done;
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps a freshly-grabbed missing torrent inside the grace window', async () => {
    const row = history({ id: 7, status: 'grabbed', updatedAt: new Date() });
    const { update, done } = run([], [row]);
    await done;
    expect(update).not.toHaveBeenCalled();
  });

  it('clears the orphan stamp when the torrent reappears', async () => {
    const row = history({
      id: 9,
      status: 'failed',
      statusMessage: ORPHAN_MESSAGE,
      updatedAt: HOUR_AGO,
    });
    const { update, done } = run([torrent('h1')], [row]);
    await done;
    expect(update).toHaveBeenCalledWith([9], {
      status: 'grabbed',
      statusMessage: null,
    });
  });

  it('does not revive a row that failed for a different reason', async () => {
    const row = history({
      id: 9,
      status: 'failed',
      statusMessage: 'Stalled — removed by aggressive cleanup profile',
      updatedAt: HOUR_AGO,
    });
    const { update, done } = run([torrent('h1')], [row]);
    await done;
    expect(update).not.toHaveBeenCalled();
  });

  it('flips an importing row to failed once its torrent is gone past the grace', async () => {
    const row = history({
      id: 12,
      status: 'importing',
      torrentHash: 'h2',
      updatedAt: HOUR_AGO,
    });
    const { update, done } = run([], [], [row]);
    await done;
    expect(update).toHaveBeenCalledWith([12], {
      status: 'failed',
      statusMessage: ORPHAN_MESSAGE,
    });
  });

  it('leaves an importing row alone while its torrent is still present', async () => {
    const row = history({
      id: 12,
      status: 'importing',
      torrentHash: 'h2',
      updatedAt: HOUR_AGO,
    });
    const { update, done } = run([torrent('h2')], [], [row]);
    await done;
    expect(update).not.toHaveBeenCalled();
  });

  it('emits queue.updated on a change, and stays silent when nothing moved', async () => {
    const gone = history({ id: 7, status: 'grabbed', updatedAt: HOUR_AGO });
    const flip = run([], [gone]);
    await flip.done;
    expect(flip.emit).toHaveBeenCalledWith({ type: 'queue.updated' });

    const stillThere = history({ id: 8, status: 'grabbed', updatedAt: HOUR_AGO });
    const noop = run([torrent('h1')], [stillThere]);
    await noop.done;
    expect(noop.emit).not.toHaveBeenCalled();
  });
});

describe('CompletionService.cleanSeededTorrents', () => {
  const DAY_SEC = 86400;
  const nowSec = Math.floor(Date.now() / 1000);

  /** Same bare-prototype approach as above, wiring only the collaborators
   *  `cleanSeededTorrents` reads. */
  function run(
    seeded: Partial<QbittorrentTorrent>,
    settings: Record<string, unknown>,
  ) {
    const deleteTorrent = jest.fn().mockResolvedValue(undefined);
    const service = Object.create(CompletionService.prototype) as CompletionService;
    const qb = {
      where: () => qb,
      andWhere: () => qb,
      // Uppercase hash on purpose: rows written from an indexer-supplied hash
      // must still resolve against qBit's lowercase one.
      getMany: async () => [
        history({
          id: 3,
          status: 'completed',
          torrentHash: 'H1',
          indexerId: 5,
        }),
      ],
    };
    const wired = service as unknown as Record<string, unknown>;
    wired.clientRepo = { find: async () => [{ id: 1 }] };
    wired.qbittorrent = {
      supports: () => true,
      getTorrents: async () => [
        { hash: 'h1', name: 'pack', ratio: 0, completion_on: nowSec, ...seeded },
      ],
      deleteTorrent,
    };
    wired.historyRepo = { createQueryBuilder: () => qb };
    wired.indexerRepo = { find: async () => [{ id: 5, settings }] };
    wired.log = { log: jest.fn(), error: jest.fn() };
    wired.events = { emit: jest.fn() };
    return { deleteTorrent, done: service.cleanSeededTorrents() };
  }

  it('removes a torrent past its retention even when the ratio target is unmet', async () => {
    const { deleteTorrent, done } = run(
      { ratio: 0.1, completion_on: nowSec - 26 * DAY_SEC },
      { seedRatio: 1, maxRetentionDays: 2 },
    );
    await done;
    // Third arg = delete the payload files, not just the torrent entry.
    expect(deleteTorrent).toHaveBeenCalledWith({ id: 1 }, 'h1', true);
  });

  it('keeps a torrent that meets neither retention nor ratio', async () => {
    const { deleteTorrent, done } = run(
      { ratio: 0.1, completion_on: nowSec - DAY_SEC },
      { seedRatio: 1, maxRetentionDays: 2 },
    );
    await done;
    expect(deleteTorrent).not.toHaveBeenCalled();
  });

  it('still removes on the ratio target when no retention is configured', async () => {
    const { deleteTorrent, done } = run({ ratio: 1.5 }, { seedRatio: 1 });
    await done;
    expect(deleteTorrent).toHaveBeenCalledWith({ id: 1 }, 'h1', true);
  });
});
