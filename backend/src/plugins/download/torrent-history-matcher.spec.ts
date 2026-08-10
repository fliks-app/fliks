import {
  TorrentHistoryMatcher,
  normaliseTorrentName,
} from './torrent-history-matcher.service';
import { DownloadHistory } from './entities/download-history.entity';

const row = (over: Partial<DownloadHistory>): DownloadHistory =>
  ({
    id: 1,
    status: 'grabbed',
    sourceTitle: 'Show.S01.1080p-GROUP',
    torrentHash: 'h1',
    ...over,
  }) as DownloadHistory;

/** `findMatch` reads no collaborator, so a bare prototype is enough. */
const matcher = () =>
  Object.create(TorrentHistoryMatcher.prototype) as TorrentHistoryMatcher;

describe('TorrentHistoryMatcher.findMatch priority', () => {
  const torrent = { hash: 'h1', name: 'Show.S01.1080p-GROUP' };

  it('prefers the live row over an already-completed one on a shared hash', () => {
    const rows = [
      row({ id: 10, status: 'completed', mediaId: 42 }),
      row({ id: 11, status: 'grabbed', mediaId: 42 }),
      row({ id: 12, status: 'completed', mediaId: 42 }),
    ];
    expect(matcher().findMatch(torrent, rows)?.history.id).toBe(11);
  });

  it('prefers a media-linked row over a media-less one', () => {
    const rows = [
      row({ id: 20, status: 'grabbed', mediaId: 42 }),
      row({ id: 21, status: 'grabbed' }),
    ];
    expect(matcher().findMatch(torrent, rows)?.history.id).toBe(20);
  });

  it('falls back to the most recent row when rank ties', () => {
    const rows = [
      row({ id: 30, status: 'completed', mediaId: 42 }),
      row({ id: 31, status: 'completed', mediaId: 42 }),
    ];
    expect(matcher().findMatch(torrent, rows)?.history.id).toBe(31);
  });

  it('ranks rows sharing a title instead of refusing to choose', () => {
    const rows = [
      row({
        id: 40,
        status: 'completed',
        mediaId: 42,
        torrentHash: null as unknown as string,
      }),
      row({
        id: 41,
        status: 'grabbed',
        mediaId: 42,
        torrentHash: null as unknown as string,
      }),
    ];
    const match = matcher().findMatch(
      { hash: 'h9', name: 'Show_S01_1080p-GROUP' },
      rows,
    );
    expect(match?.matchedBy).toBe('exact-name');
    expect(match?.history.id).toBe(41);
  });

  it('still refuses an ambiguous prefix overlap', () => {
    const rows = [
      row({
        id: 50,
        sourceTitle: 'Show.S01',
        torrentHash: null as unknown as string,
      }),
      row({
        id: 51,
        sourceTitle: 'Show.S01.1080p',
        torrentHash: null as unknown as string,
      }),
    ];
    const log = { warn: jest.fn() };
    const m = matcher();
    (m as unknown as { log: unknown }).log = log;
    expect(
      m.findMatch({ hash: 'h9', name: 'Show.S01.1080p-GROUP' }, rows),
    ).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('normaliseTorrentName', () => {
  it('decodes HTML entities qBittorrent renders on display', () => {
    expect(normaliseTorrentName('Show &amp; Co S01E01-GROUP')).toBe(
      'show & co s01e01-group',
    );
    expect(normaliseTorrentName('Berl&iacute;n.S02E01.1080p.WEB-DL.x265')).toBe(
      'berlín s02e01 1080p web-dl x265',
    );
  });

  it('decodes numeric and hex character references', () => {
    expect(normaliseTorrentName('Mum&#39;s.S01.WEB-DL')).toBe(
      "mum's s01 web-dl",
    );
    expect(normaliseTorrentName('A&#x26;B.S01')).toBe('a&b s01');
  });

  it('treats dots, underscores and spaces as equivalent separators', () => {
    expect(normaliseTorrentName('Show.S01E01-GROUP')).toBe(
      normaliseTorrentName('Show S01E01-GROUP'),
    );
    expect(normaliseTorrentName('Show_S01E01.GROUP')).toBe(
      normaliseTorrentName('Show.S01E01.GROUP'),
    );
  });

  it('is case-insensitive', () => {
    expect(normaliseTorrentName('Show S01E01')).toBe(
      normaliseTorrentName('SHOW S01E01'),
    );
  });

  it('handles the empty / nullish input', () => {
    expect(normaliseTorrentName('')).toBe('');
  });
});
