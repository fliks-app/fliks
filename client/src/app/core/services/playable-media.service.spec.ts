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

  it('carries the picks made before play to the local player as navigation state', async () => {
    const navigate = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        PlayableMediaService,
        { provide: Router, useValue: { navigate } },
        { provide: CastService, useValue: { isConnected: () => false } },
        { provide: CastPlayerService, useValue: {} },
        { provide: StreamingApiService, useValue: {} },
        {
          provide: MediaService,
          useValue: { getOne: () => Promise.resolve({}), getCast: () => Promise.resolve([]), getCrew: () => Promise.resolve([]) },
        },
        { provide: PlaybackQueueService, useValue: { clear: vi.fn() } },
        { provide: RemoteService, useValue: { selectedTargetId: () => null } },
      ],
    });
    const tracks = { fileId: 7, audioStreamIndex: 1, subtitleId: null };

    await TestBed.inject(PlayableMediaService).play({ fileId: 7, mediaId: 1, title: 'T', tracks }, false);

    expect(navigate.mock.calls[0][1].state.tracks).toEqual(tracks);
  });
});
