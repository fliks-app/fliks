import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AuthService } from './auth.service';
import { DownloadCacheService } from './download-cache.service';
import { OfflineBookStoreService } from './offline-book-store.service';
import { ServerConfigService } from './server-config.service';

type Priv = { get(key: string): Promise<Blob | null>; put(key: string, blob: Blob): Promise<unknown> };

const BASE = new URL('/api/books/7/pub/', document.baseURI).href;

describe('OfflineBookStoreService', () => {
  const blobs = new Map<string, Blob>();
  let svc: OfflineBookStoreService;
  let created: MockInstance<typeof URL.createObjectURL>;
  let revoked: MockInstance<typeof URL.revokeObjectURL>;

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
    // jsdom has no object URLs: spyOn needs a property to wrap.
    for (const k of ['createObjectURL', 'revokeObjectURL'] as const) {
      if (!URL[k]) Object.defineProperty(URL, k, { configurable: true, writable: true, value: () => '' });
    }
    let n = 0;
    created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:local/${++n}`);
    revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
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
    const css = created.mock.calls.map((c) => c[0] as Blob).find((b) => b.type === 'text/css')!;
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

  const native = () => ((TestBed.inject(ServerConfigService) as { isNative: boolean }).isNative = true);
  const CHAPTER = '<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="../s.css"/></head><body><img src="a.png"/><img src="https://elsewhere/x.png"/><img src="/api/users/me"/></body></html>';
  const server = () => {
    const served: Record<string, [string, string]> = {
      'OEBPS/ch1.xhtml': [CHAPTER, 'application/xhtml+xml; charset=utf-8'],
      's.css': ['@font-face{src:url("f.woff")}', 'text/css'],
      'f.woff': ['font', 'font/woff'],
      'OEBPS/a.png': ['png', 'image/png'],
    };
    const net = vi.fn(async (url: string, _init?: RequestInit) => {
      const hit = served[String(url).replace(BASE, '')];
      return hit ? new Response(hit[0], { headers: { 'content-type': hit[1] } }) : new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', net);
    return net;
  };

  it('hands an app frame a served chapter whose own resources are object URLs fetched with the token', async () => {
    native();
    const net = server();
    const html = await (await svc.fetch(`${BASE}OEBPS/ch1.xhtml`)).text();
    expect(html).toContain('href="blob:local/');
    expect(html).toContain('src="blob:local/');
    expect(html).not.toContain('a.png');
    // Off the book, nothing is fetched: the token would go along.
    expect(html).toContain('https://elsewhere/x.png');
    expect(html).toContain('src="/api/users/me"');
    expect(net.mock.calls.map((c) => String(c[0]).replace(BASE, '')).sort()).toEqual(['OEBPS/a.png', 'OEBPS/ch1.xhtml', 'f.woff', 's.css']);
    for (const [, init] of net.mock.calls) expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
    // The resources: a redirect would carry the token elsewhere.
    expect(net.mock.calls.filter(([, init]) => init?.redirect === 'error')).toHaveLength(3);
    const css = created.mock.calls.map((c) => c[0] as Blob).find((b) => b.type === 'text/css')!;
    expect(await css.text()).toContain('url("blob:local/');
  });

  it('leaves a served chapter as it is on the web, where the frame has the cookie', async () => {
    const net = server();
    expect(await (await svc.fetch(`${BASE}OEBPS/ch1.xhtml`)).text()).toBe(CHAPTER);
    expect(net).toHaveBeenCalledOnce();
  });

  it('reads a chapter without its resources when asked not to inline', async () => {
    native();
    const net = server();
    expect(await (await svc.fetch(`${BASE}OEBPS/ch1.xhtml`, undefined, false)).text()).toBe(CHAPTER);
    expect(net).toHaveBeenCalledOnce();
  });

  it('revokes the object URLs of a book on release and makes them again on the next read', async () => {
    keep('ch1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="a.png"/></body></html>', 'application/xhtml+xml');
    keep('a.png', 'png', 'image/png');
    await svc.fetch(`${BASE}ch1.xhtml`);
    svc.release(7);
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledWith('blob:local/1'));
    expect(await (await svc.fetch(`${BASE}ch1.xhtml`)).text()).toContain('blob:local/2');
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

  it('makes one object URL for a stylesheet two chapters ask for at once', async () => {
    const chapter = '<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="s.css"/></head><body/></html>';
    keep('ch1.xhtml', chapter, 'application/xhtml+xml');
    keep('ch2.xhtml', chapter, 'application/xhtml+xml');
    keep('s.css', 'p{color:red}', 'text/css');
    await Promise.all([svc.fetch(`${BASE}ch1.xhtml`), svc.fetch(`${BASE}ch2.xhtml`)]);
    expect(created).toHaveBeenCalledOnce();
  });

  it('makes no object URL for a book released while its chapter is being inlined', async () => {
    keep('ch1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="a.png"/></body></html>', 'application/xhtml+xml');
    keep('a.png', 'png', 'image/png');
    const read = (svc as unknown as Priv).get;
    (svc as unknown as Priv).get = async (key) => {
      if (key.endsWith('a.png')) svc.release(7);
      return read(key);
    };
    expect(await (await svc.fetch(`${BASE}ch1.xhtml`)).text()).toContain('src="a.png"');
    expect(created).not.toHaveBeenCalled();
  });

  it('resolves the string form of @import and keeps a fragment on the object URL', async () => {
    keep('a.css', '@import "b.css"; @IMPORT \'c.css\'; p{background:URL(sprite.svg#dot)}', 'text/css');
    keep('b.css', 'b{}', 'text/css');
    keep('c.css', 'c{}', 'text/css');
    keep('sprite.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml');
    const css = await (await svc.fetch(`${BASE}a.css`)).text();
    expect(css).not.toMatch(/b\.css|c\.css|sprite\.svg/);
    expect(css).toMatch(/@import "blob:local\/\d"; @import "blob:local\/\d"/);
    expect(css).toMatch(/url\("blob:local\/\d#dot"\)/);
  });

  it('ends an @import cycle between two stored stylesheets', async () => {
    keep('a.css', '@import url("b.css"); p{color:red}', 'text/css');
    keep('b.css', '@import url("a.css"); i{color:blue}', 'text/css');
    const res = await svc.fetch(`${BASE}a.css`);
    expect(await res.text()).toContain('p{color:red}');
  });

  it('streams a file into chunk records and rebuilds it from them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello world', { headers: { 'content-type': 'audio/mpeg' } })));
    (svc as unknown as Priv).put = async (key, blob) => void blobs.set(key, blob);
    const bytes = await svc.storeFile({ family: 'audio' }, '9-0', '/api/stream/9/parts/0?token=t', vi.fn());
    expect(bytes).toBe(11);
    expect([...blobs.keys()].sort()).toEqual(['s|file|9-0', 's|file|9-0|000000']);
    created.mockImplementation(() => 'blob:local/file');
    expect(await svc.fileUrl({ family: 'audio' }, '9-0')).toBe('blob:local/file');
    expect(await (created.mock.calls[0][0] as Blob).text()).toBe('hello world');
  });
});
