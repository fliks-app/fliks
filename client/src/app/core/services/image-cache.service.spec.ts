import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { cacheKey, ImageCacheService } from './image-cache.service';
import { DeviceService } from './device.service';
import { NetworkService } from './network.service';

const fs = vi.hoisted(() => ({
  rmdir: vi.fn(() => Promise.resolve()),
  mkdir: vi.fn(() => Promise.resolve()),
  writeFile: vi.fn(() => Promise.resolve()),
  deleteFile: vi.fn(() => Promise.resolve()),
  getUri: vi.fn(() => Promise.resolve({ uri: 'file:///data/fliks-images' })),
}));
vi.mock('@capacitor/filesystem', () => ({ Filesystem: fs, Directory: { Data: 'DATA' } }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, convertFileSrc: (s: string) => s },
}));

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

describe('ImageCacheService on native', () => {
  const INDEX_KEY = 'fliks.imageCache.index';
  const setup = (isTv: boolean) => {
    TestBed.configureTestingModule({
      providers: [
        { provide: DeviceService, useValue: { isTv: () => isTv } },
        { provide: NetworkService, useValue: { isOnline: () => true } },
      ],
    });
    return TestBed.inject(ImageCacheService);
  };
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('deletes the directory and index an older install left on TV, once', async () => {
    localStorage.setItem(INDEX_KEY, '{}');
    const cache = setup(true);
    await cache.warm();
    await vi.waitFor(() => expect(localStorage.getItem(INDEX_KEY)).toBeNull());
    expect(fs.rmdir).toHaveBeenCalledTimes(1);
    await cache.warm();
    expect(fs.rmdir).toHaveBeenCalledTimes(1);
  });

  it('writes the index right after an eviction batch, not at idle', async () => {
    const old = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`k${i}`, [`f${i}.jpg`, i]]));
    localStorage.setItem(INDEX_KEY, JSON.stringify(old));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['x'], { type: 'image/jpeg' }))));
    const cache = setup(false);
    expect(await cache.prefetch('https://media.example.com/api/images/1')).toBe(true);
    expect(fs.deleteFile).toHaveBeenCalledTimes(101);
    expect(Object.keys(JSON.parse(localStorage.getItem(INDEX_KEY)!))).toHaveLength(700);
  });
});
