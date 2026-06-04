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
  };
  wired.historyRepo = { update };
  wired.historyMatcher = matcher;
  wired.log = { warn: jest.fn(), log: jest.fn() };
  return { service, update };
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
  function run(torrents: QbittorrentTorrent[], rows: DownloadHistory[]) {
    const present = new Set(torrents.map((t) => t.hash));
    const { service, update } = buildService(present);
    return {
      update,
      done: (
        service as unknown as {
          reconcileOrphanHistory: (
            t: QbittorrentTorrent[],
            g: DownloadHistory[],
          ) => Promise<void>;
        }
      ).reconcileOrphanHistory(torrents, rows),
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
});
