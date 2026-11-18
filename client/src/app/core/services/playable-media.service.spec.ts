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
import { PartyService } from './party/party.service';
import { CastPlaybackTarget } from './cast-playback-target';
import { RemotePlaybackTarget } from './remote-playback-target';

describe('PlayableMediaService.play', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(over: { cast?: boolean; target?: string | null; owner?: string } = {}) {
    const navigate = vi.fn();
    const queue = { clear: vi.fn(), start: vi.fn() };
    const quickStart = vi.fn(async (_opts: { tracks?: unknown }) => {});
    const send = vi.fn(async (_target: string, _cmd: Record<string, unknown>) => {});
    TestBed.configureTestingModule({
      providers: [
        PlayableMediaService,
        { provide: Router, useValue: { navigate, url: '/' } },
        { provide: CastService, useValue: { isConnected: () => !!over.cast } },
        { provide: CastPlayerService, useValue: { quickStart } },
        { provide: StreamingApiService, useValue: {} },
        {
          provide: MediaService,
          useValue: { getOne: () => Promise.resolve({}), getCast: () => Promise.resolve([]), getCrew: () => Promise.resolve([]) },
        },
        { provide: PlaybackQueueService, useValue: queue },
        { provide: RemoteService, useValue: { selectedTargetId: () => over.target ?? null, observedTargetId: () => over.target ?? null, playTarget: () => over.target ?? over.owner ?? null, send } },
        { provide: PartyService, useValue: { party: () => null, active: () => false, drives: () => false } },
        { provide: CastPlaybackTarget, useValue: { isConnected: () => !!over.cast } },
        { provide: RemotePlaybackTarget, useValue: { isConnected: () => !!over.target, isObserving: () => false } },
      ],
    });
    return { service: TestBed.inject(PlayableMediaService), navigate, quickStart, send, queue };
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

  it('sends a play to the live owner of the session without opening a player here', async () => {
    const { service, send, navigate } = setup({ owner: 'tv#1' });
    await service.play(ctx, false);
    expect(send).toHaveBeenCalledWith('tv#1', expect.objectContaining({ action: 'load', mediaFileId: 7 }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps no local queue for a playlist the session owner plays', async () => {
    const { service, send, queue } = setup({ owner: 'tv#1' });
    TestBed.inject(MediaService).getOne = vi.fn(async () => ({ id: 1, files: [{ id: 7, episodeId: null }] })) as never;
    expect(await service.playFromPlaylist(3, [{ mediaId: 1 } as never], 0, true)).toBe(true);
    expect(queue.start).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('tv#1', expect.objectContaining({ action: 'load', mediaFileId: 7 }));
  });

  it('sends no pick to a remote target when it was made on another file', async () => {
    const { service, send } = setup({ target: 'tv#1' });
    await service.play({ ...ctx, fileId: 8 }, false);
    const cmd = send.mock.calls[0][1];
    expect(cmd['trackId']).toBeUndefined();
    expect(cmd['subtitleId']).toBeUndefined();
  });
});
