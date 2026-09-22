import { describe, it, expect } from 'vitest';
import { cacheKey } from './image-cache.service';

/**
 * A Live TV logo's `?token=` rotates with the session even though the image
 * on disk never changes; the cache key must ignore it or every rotation
 * would look like a brand-new image and churn the on-disk LRU.
 */
// Native always hands cacheKey an already-resolved, absolute URL (see
// ResolveUrlPipe / ServerConfigService.resolveUrl) — never a bare path.
const base = 'https://media.example.com';

describe('cacheKey', () => {
  it('is stable across a rotated token for the same image', () => {
    const a = cacheKey(`${base}/api/livetv/channels/12/logo?size=thumb&token=aaa`);
    const b = cacheKey(`${base}/api/livetv/channels/12/logo?size=thumb&token=bbb`);
    expect(a).toBe(b);
  });

  it('still differs for a different image', () => {
    const a = cacheKey(`${base}/api/livetv/channels/12/logo?size=thumb&token=aaa`);
    const b = cacheKey(`${base}/api/livetv/channels/13/logo?size=thumb&token=aaa`);
    expect(a).not.toBe(b);
  });

  it('still differs for a different size of the same image', () => {
    const a = cacheKey(`${base}/api/livetv/channels/12/logo?size=thumb&token=aaa`);
    const b = cacheKey(`${base}/api/livetv/channels/12/logo?size=medium&token=aaa`);
    expect(a).not.toBe(b);
  });
});
