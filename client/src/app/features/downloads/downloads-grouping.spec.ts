import type { DownloadTask } from '../../core/services/download-cache.service';
import { groupDownloads, parseEpisodeLabel } from './downloads-grouping';

const task = (id: number, over: Partial<DownloadTask> = {}): DownloadTask => ({
  id,
  mediaId: 1,
  mediaFileId: id,
  quality: '1080p',
  status: 'ready',
  progress: 100,
  createdAt: '',
  media: { id: 1, title: 'Show', posterUrl: null, type: 'tv' },
  ...over,
});

describe('downloads grouping', () => {
  it('parses SxxEyy labels', () => {
    expect(parseEpisodeLabel('S02E10 Title')).toEqual({ season: 2, episode: 10 });
    expect(parseEpisodeLabel('Title')).toBeNull();
    expect(parseEpisodeLabel()).toBeNull();
  });

  it('keeps movies single and groups episodes by series then season, numerically', () => {
    const entries = groupDownloads([
      task(1, { episodeId: 1, episodeLabel: 'S01E10', sizeBytes: 10 }),
      task(2, { episodeId: 2, episodeLabel: 'S01E02', sizeBytes: 20 }),
      task(3, { episodeId: 3, seasonNumber: 0, episodeNumber: 1 }),
      task(4, { mediaId: 2, media: { id: 2, title: 'Alpha', posterUrl: null, type: 'movie' } }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(['show', 'movie']);
    const show = entries[0].kind === 'show' ? entries[0].show : null!;
    expect(show.seasons.map((s) => s.seasonNumber)).toEqual([0, 1]);
    expect(show.seasons[1].tasks.map((t) => t.id)).toEqual([2, 1]);
    expect(show.sizeBytes).toBe(30);
    expect(show.tasks).toHaveLength(3);
  });

  it('orders entries by their latest download, newest last', () => {
    const entries = groupDownloads([
      task(1, { mediaId: 2, createdAt: '2026-10-22T10:00:00Z', media: { id: 2, title: 'Zulu', posterUrl: null, type: 'movie' } }),
      task(2, { episodeId: 2, episodeLabel: 'S01E01', createdAt: '2026-10-21T10:00:00Z' }),
      task(3, { episodeId: 3, episodeLabel: 'S01E02', createdAt: '2026-10-22T12:00:00Z' }),
      task(4, { mediaId: 3, createdAt: '2026-10-22T11:00:00Z', media: { id: 3, title: 'Alpha', posterUrl: null, type: 'movie' } }),
    ]);
    expect(entries.map((e) => (e.kind === 'movie' ? e.task.media?.title : e.show.title))).toEqual(['Zulu', 'Alpha', 'Show']);
  });

  it('puts episodes with no readable season last', () => {
    const entries = groupDownloads([
      task(1, { episodeId: 1, episodeLabel: 'Pilot' }),
      task(2, { episodeId: 2, episodeLabel: 'S01E01' }),
    ]);
    const show = entries[0].kind === 'show' ? entries[0].show : null!;
    expect(show.seasons.map((s) => s.seasonNumber)).toEqual([1, null]);
  });
});
