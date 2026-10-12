import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CastPlayerService } from './cast-player.service';

type Priv = {
  dispatchLoad(...args: unknown[]): Promise<boolean>;
};

function make(loadMedia: ReturnType<typeof vi.fn>, connected = true) {
  const svc = Object.create(CastPlayerService.prototype) as Record<string, unknown>;
  const buffering = { set: vi.fn() };
  const toast = { error: vi.fn() };
  svc['cast'] = { loadMedia, isConnected: () => connected, buffering, setCastStreamBase: vi.fn() };
  svc['toast'] = toast;
  svc['translate'] = { instant: (k: string) => k };
  svc['streamingApi'] = { buildAbsolutePlayUrl: () => ({ url: 'u', contentType: 'c' }) };
  svc['authService'] = { user: () => null };
  svc['playbackMode'] = signal('transcode');
  svc['liveSessionId'] = signal<string | null>(null);
  svc['availableSubtitles'] = signal([]);
  for (const k of ['activeSubtitleId', 'fanartUrl']) svc[k] = signal(null);
  for (const k of ['mediaTitle', 'episodeTitle']) svc[k] = signal('t');
  for (const k of ['mediaId', 'episodeId']) svc[k] = signal(1);
  const run = () =>
    (svc as unknown as Priv).dispatchLoad(1, { playMethod: 'Transcode', playUrl: 'p' }, 0, 'q', { token: 'k', streamBaseUrl: 'b' }, true);
  return { run, buffering, toast };
}

describe('cast LOAD failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  it('retries once, then stops loading and toasts', async () => {
    const loadMedia = vi.fn().mockRejectedValue(new Error('LOAD_FAILED'));
    const { run, buffering, toast } = make(loadMedia);
    const done = run();
    await vi.advanceTimersByTimeAsync(5000);

    expect(await done).toBe(false);
    expect(loadMedia).toHaveBeenCalledTimes(2);
    expect(buffering.set).toHaveBeenLastCalledWith(false);
    expect(toast.error).toHaveBeenCalledWith('cast.error.load_failed');
  });

  it('succeeds silently when the retry goes through', async () => {
    const loadMedia = vi.fn().mockRejectedValueOnce(new Error('LOAD_FAILED')).mockResolvedValue(undefined);
    const { run, buffering, toast } = make(loadMedia);
    const done = run();
    await vi.advanceTimersByTimeAsync(5000);

    expect(await done).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
    expect(buffering.set).not.toHaveBeenCalledWith(false);
  });

  it('does not retry while disconnected', async () => {
    const loadMedia = vi.fn().mockRejectedValue(new Error('x'));
    const { run, toast } = make(loadMedia, false);

    expect(await run()).toBe(false);
    expect(loadMedia).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
