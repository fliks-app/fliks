import { describe, expect, it } from 'vitest';
import { subtitleManifestRank, subtitleTrackKey } from './subtitle-tracks';

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
