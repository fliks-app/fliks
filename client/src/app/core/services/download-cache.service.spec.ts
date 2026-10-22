import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadCacheService, type DownloadTask } from './download-cache.service';
import { AuthService } from './auth.service';
import { ServerConfigService } from './server-config.service';

const KEY = 'fliks.downloads.cache.s::1';
const task = (id: number, status: string): DownloadTask =>
  ({ id, mediaId: 1, mediaFileId: id, quality: '1080p', status, progress: 0, createdAt: '' }) as DownloadTask;

function setup() {
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { user: signal({ id: 1 }) } },
      { provide: ServerConfigService, useValue: { serverUrl: signal('s') } },
    ],
  });
  return TestBed.inject(DownloadCacheService);
}

describe('DownloadCacheService', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('migrates the statuses saved before the union', () => {
    localStorage.setItem(KEY, JSON.stringify([task(1, 'transcoding'), task(2, 'pending'), task(3, 'ready')]));
    expect(setup().tasks().map((t) => t.status)).toEqual(['preparing', 'preparing', 'ready']);
  });

  it('updates the signal at once and trails the localStorage write on a lazy save', () => {
    const cache = setup();
    cache.save([task(1, 'downloading')], true);
    expect(cache.tasks()[0].status).toBe('downloading');
    expect(localStorage.getItem(KEY)).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(localStorage.getItem(KEY)!)[0].status).toBe('downloading');
  });

  it('writes a plain save through and drops the pending lazy one', () => {
    const cache = setup();
    cache.save([task(1, 'downloading')], true);
    cache.save([task(1, 'ready')]);
    expect(JSON.parse(localStorage.getItem(KEY)!)[0].status).toBe('ready');
    localStorage.removeItem(KEY);
    vi.advanceTimersByTime(1000);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
