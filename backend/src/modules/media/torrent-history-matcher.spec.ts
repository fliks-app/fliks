import { normaliseTorrentName } from './torrent-history-matcher.service';

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
    expect(normaliseTorrentName("Mum&#39;s.S01.WEB-DL")).toBe(
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
