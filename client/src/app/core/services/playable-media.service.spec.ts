import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayableMediaService } from './playable-media.service';
import { CastService } from './cast.service';
import { CastPlayerService } from './cast-player.service';
import { StreamingApiService } from './api/streaming-api.service';
import { MediaService } from './api/media.service';
import { PlaybackQueueService } from './playback-queue.service';
import { RemoteService } from './remote.service';

describe('PlayableMediaService.play', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(over: { cast?: boolean; target?: string | null } = {}) {
    const navigate = vi.fn();
    const quickStart = vi.fn(async (_opts: { tracks?: unknown }) => {});
    const send = vi.fn(async (_target: string, _cmd: Record<string, unknown>) => {});
    TestBed.configureTestingModule({
      providers: [
        PlayableMediaService,
        { provide: Router, useValue: { navigate } },
        { provide: CastService, useValue: { isConnected: () => !!over.cast } },
        { provide: CastPlayerService, useValue: { quickStart, expanded: { set: vi.fn() } } },
        { provide: StreamingApiService, useValue: {} },
        {
          provide: MediaService,
          useValue: { getOne: () => Promise.resolve({}), getCast: () => Promise.resolve([]), getCrew: () => Promise.resolve([]) },
        },
        { provide: PlaybackQueueService, useValue: { clear: vi.fn() } },
        { provide: RemoteService, useValue: { selectedTargetId: () => over.target ?? null, send } },
      ],
    });
    return { service: TestBed.inject(PlayableMediaService), navigate, quickStart, send };
  }

  const tracks = { fileId: 7, audioStreamIndex: 1, subtitleId: null };
  const ctx = { fileId: 7, mediaId: 1, title: 'T', tracks };

  it('carries the picks made before play to the local player as navigation state', async () => {
    const { service, navigate } = setup();
    await service.play(ctx, false);
    expect(navigate.mock.calls[0][1].state.tracks).toEqual(tracks);
  });

  it('hands the picks to the Cast quick start', async () => {
    const { service, quickStart } = setup({ cast: true });
    await service.play(ctx, false);
    expect(quickStart.mock.calls[0][0].tracks).toEqual(tracks);
  });

  it('sends the picks to a remote target, with Off as an explicit null', async () => {
    const { service, send } = setup({ target: 'tv#1' });
    await service.play(ctx, false);
    const cmd = send.mock.calls[0][1];
    expect(cmd).toMatchObject({ action: 'load', mediaFileId: 7, trackId: 'audio-1', subtitleId: null });
  });

  it('sends no pick to a remote target when it was made on another file', async () => {
    const { service, send } = setup({ target: 'tv#1' });
    await service.play({ ...ctx, fileId: 8 }, false);
    const cmd = send.mock.calls[0][1];
    expect(cmd['trackId']).toBeUndefined();
    expect(cmd['subtitleId']).toBeUndefined();
  });
});
