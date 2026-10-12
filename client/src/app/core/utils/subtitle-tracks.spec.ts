import { describe, expect, it } from 'vitest';
import { buildSubtitleTracks, embeddedSubtitleTitle, subtitleManifestRank, subtitleTrackKey } from './subtitle-tracks';

describe('subtitle track identity', () => {
  it('keys a sidecar by its DB id and an in-container track by its stream index', () => {
    expect(subtitleTrackKey({ id: 12, relativePath: 'a.srt', streamIndex: null })?.key).toBe('ext-12');
    expect(subtitleTrackKey({ id: 12, relativePath: null, streamIndex: 3 })?.key).toBe('emb-3');
    expect(subtitleTrackKey({ id: 12 })).toBeNull();
  });

  it('ranks embedded tracks by stream index, ahead of sidecars by DB id', () => {
    const keys = ['ext-9', 'emb-4', 'ext-2', 'emb-1'];
    expect([...keys].sort((a, b) => subtitleManifestRank(a) - subtitleManifestRank(b))).toEqual([
      'emb-1', 'emb-4', 'ext-2', 'ext-9',
    ]);
  });
});

describe('embedded subtitle titles', () => {
  const streams = [{ streamIndex: 10, title: 'Latin American' }, { streamIndex: 11 }];
  const row = (id: number, streamIndex: number | null, relativePath: string | null = null) =>
    ({ id, mediaFileId: 1, language: 'spa', streamIndex, relativePath });

  it('reads the title from the stream with the same index', () => {
    expect(embeddedSubtitleTitle(row(1, 10), streams)).toBe('Latin American');
    expect(embeddedSubtitleTitle(row(2, 11), streams)).toBeNull();
    expect(embeddedSubtitleTitle(row(3, 10), undefined)).toBeNull();
  });

  it('leaves a sidecar file untitled', () => {
    expect(embeddedSubtitleTitle(row(4, 10, 'a.srt'), streams)).toBeNull();
  });

  it('carries the title onto the built tracks', () => {
    const tracks = buildSubtitleTracks([row(1, 10), row(2, 11)], 1, { hideBurnIn: false, streams });
    expect(tracks.map((t) => [t.key, t.title])).toEqual([['emb-10', 'Latin American'], ['emb-11', null]]);
  });
});
