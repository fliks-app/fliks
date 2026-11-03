import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { DownloadCacheService } from './download-cache.service';
import { OfflineBookStoreService } from './offline-book-store.service';
import { ServerConfigService } from './server-config.service';

type Priv = { get(key: string): Promise<Blob | null>; put(key: string, blob: Blob): Promise<unknown> };

const BASE = new URL('/api/books/7/pub/', document.baseURI).href;

describe('OfflineBookStoreService', () => {
  const blobs = new Map<string, Blob>();
  let svc: OfflineBookStoreService;

  beforeEach(() => {
    blobs.clear();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { accessToken: 'tok' } },
        { provide: ServerConfigService, useValue: { isNative: false, resolveUrl: (u: string) => u } },
        { provide: DownloadCacheService, useValue: { scopeSuffix: () => 's' } },
      ],
    });
    svc = TestBed.inject(OfflineBookStoreService);
    (svc as unknown as Priv).get = async (key) => blobs.get(key) ?? null;
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:local/${++n}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const keep = (path: string, body: string, type: string) => blobs.set(`s|${BASE}${path}`, new Blob([body], { type }));

  it('serves a stored chapter with its images, styles and fonts pointing at the stored copies', async () => {
    keep('ch1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="s.css"/></head><body><img src="img/a.png"/><img src="https://elsewhere/x.png"/></body></html>', 'application/xhtml+xml');
    keep('s.css', '@font-face{src:url("f.woff")} p{background:url(img/a.png)}', 'text/css');
    keep('f.woff', 'font', 'font/woff');
    keep('img/a.png', 'png', 'image/png');
    const res = await svc.fetch(`${BASE}ch1.xhtml`);
    const html = await res.text();
    expect(res.headers.get('content-type')).toBe('application/xhtml+xml');
    expect(html).toContain('src="blob:local/');
    expect(html).toContain('href="blob:local/');
    expect(html).toContain('https://elsewhere/x.png');
    expect(html).not.toContain('img/a.png');
    // The stylesheet was rewritten before it got its object URL: the font and the image are stored ones.
    const css = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as Blob).find((b) => b.type === 'text/css')!;
    const text = await css.text();
    expect(text).toContain('url("blob:local/');
    expect(text).not.toContain('f.woff');
  });

  it('falls back to the network, with the app credentials, for what is not stored', async () => {
    const net = vi.fn(async () => new Response('x'));
    vi.stubGlobal('fetch', net);
    await svc.fetch(`${BASE}missing.xhtml`);
    expect(net).toHaveBeenCalledOnce();
    expect((net.mock.calls[0] as unknown as [string, RequestInit])[1].credentials).toBe('include');
    vi.unstubAllGlobals();
  });

  it('stores the manifest and every resource it names, once each', async () => {
    const body = (url: string) =>
      url.endsWith('manifest.json')
        ? JSON.stringify({
            readingOrder: [{ href: 'ch1.xhtml' }],
            resources: [{ href: 'img/a.png' }, { href: 'ch1.xhtml#frag' }],
            links: [{ href: 'positions.json' }, { href: 'manifest.json' }, { href: 'search{?q}', templated: true }],
          })
        : 'data';
    const net = vi.fn(async (url: string) => new Response(body(url)));
    vi.stubGlobal('fetch', net);
    const puts: string[] = [];
    (svc as unknown as Priv).put = async (key) => void puts.push(key);
    const progress = vi.fn();
    await svc.storeEpub(7, progress);
    expect(puts.map((k) => k.replace(BASE, '')).sort()).toEqual(['s|ch1.xhtml', 's|img/a.png', 's|manifest.json', 's|positions.json']);
    expect(progress).toHaveBeenLastCalledWith(1);
    vi.unstubAllGlobals();
  });
});
