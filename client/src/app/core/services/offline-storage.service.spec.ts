import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineStorageService } from './offline-storage.service';
import { AuthService } from './auth.service';
import { DownloadCacheService } from './download-cache.service';
import { DownloadNotificationService } from './download-notification.service';
import { scopeHash } from '../utils/scope-hash';

const store = new Map<string, string>();
const fakeCaches = {
  open: async () => ({
    put: async (k: string, r: Response) => void store.set(k, await r.text()),
    match: async (k: string) => (store.has(k) ? new Response(store.get(k)) : undefined),
    delete: async (k: string) => store.delete(k),
  }),
};

function service(scope: string) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { accessToken: 't' } },
      { provide: DownloadNotificationService, useValue: {} },
      { provide: DownloadCacheService, useValue: { scopeSuffix: () => scope, load: () => [] } },
    ],
  });
  return TestBed.inject(OfflineStorageService);
}

describe('scopeHash', () => {
  it('is stable and differs per scope', () => {
    expect(scopeHash('a::1')).toBe(scopeHash('a::1'));
    expect(scopeHash('a::1')).not.toBe(scopeHash('b::1'));
  });
});

describe('OfflineStorageService sidecar scoping', () => {
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('caches', fakeCaches);
    vi.stubGlobal('fetch', async () => new Response('WEBVTT'));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x' }));
  });

  it('writes under a scope-prefixed key so two servers do not collide', async () => {
    await service('a::1').downloadSmallFile('http://x/s.vtt?token=t', 'sub-1-2');
    await service('b::1').downloadSmallFile('http://x/s.vtt?token=t', 'sub-1-2');
    expect([...store.keys()]).toEqual([`${scopeHash('a::1')}-sub-1-2`, `${scopeHash('b::1')}-sub-1-2`]);
  });

  it('deleting on one server leaves the other copy', async () => {
    await service('a::1').downloadSmallFile('http://x/s.vtt?token=t', 'sub-1-2');
    await service('b::1').downloadSmallFile('http://x/s.vtt?token=t', 'sub-1-2');
    await service('a::1').deleteSmallFile('sub-1-2');
    expect([...store.keys()]).toEqual([`${scopeHash('b::1')}-sub-1-2`]);
  });

  it('still reads a file saved before names carried the scope', async () => {
    store.set('sub-1-2', 'WEBVTT');
    expect(await service('a::1').getSmallFileUrl('sub-1-2')).toBe('blob:x');
    expect(await service('a::1').getSmallFileUrl('sub-9-9')).toBeNull();
  });
});
