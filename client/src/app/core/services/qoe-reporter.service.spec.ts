import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QOE_BUFFER_CAP, QoeReporter } from './qoe-reporter.service';
import { StreamingApiService } from './api/streaming-api.service';
import type { QoeEvent } from './api/qoe-api.service';

const ev = (at: number): QoeEvent => ({ type: 'stall', at, position: 1 });

describe('QoeReporter', () => {
  const api = { postQoeEvents: vi.fn(), getQoeEventsUrl: vi.fn((s: string) => `/e/${s}?token=t`) };
  let reporter: QoeReporter;

  beforeEach(() => {
    api.postQoeEvents.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({ providers: [{ provide: StreamingApiService, useValue: api }] });
    reporter = TestBed.inject(QoeReporter);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('batches per session and sends nothing when empty', async () => {
    reporter.record('a', ev(1));
    reporter.record('a', ev(2));
    reporter.record('b', ev(3));
    await reporter.flush('a');
    await reporter.flush('a');
    await reporter.flush('c');
    expect(api.postQoeEvents).toHaveBeenCalledTimes(1);
    expect(api.postQoeEvents).toHaveBeenCalledWith('a', [ev(1), ev(2)]);
  });

  it('flushes at once when immediate', () => {
    reporter.record('a', ev(1), true);
    expect(api.postQoeEvents).toHaveBeenCalledWith('a', [ev(1)]);
  });

  it('caps the buffer at 100, dropping the oldest', async () => {
    for (let i = 0; i < QOE_BUFFER_CAP + 5; i++) reporter.record('a', ev(i));
    await reporter.flush('a');
    const sent = api.postQoeEvents.mock.calls.flatMap((c) => c[1] as QoeEvent[]);
    expect(sent).toHaveLength(QOE_BUFFER_CAP);
    expect(sent[0].at).toBe(5);
    expect(api.postQoeEvents.mock.calls.every((c) => (c[1] as QoeEvent[]).length <= 50)).toBe(true);
  });

  it('stays silent when the request fails', async () => {
    api.postQoeEvents.mockRejectedValue(new Error('down'));
    reporter.record('a', ev(1));
    await expect(reporter.flush('a')).resolves.toBeUndefined();
  });

  it('uses a keepalive fetch on exit', () => {
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal('fetch', fetchMock);
    reporter.record('a', ev(1));
    reporter.flushKeepalive('a');
    expect(fetchMock).toHaveBeenCalledWith(
      '/e/a?token=t',
      expect.objectContaining({ method: 'POST', keepalive: true, body: JSON.stringify({ events: [ev(1)] }) }),
    );
  });
});
