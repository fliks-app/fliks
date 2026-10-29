import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { MediaService } from '../../core/services/api/media.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { LikesApiService } from '../../core/services/api/likes-api.service';
import { CastService } from '../../core/services/cast.service';
import { DeviceService } from '../../core/services/device.service';
import { NavbarService } from '../../core/services/navbar.service';
import { PartyService } from '../../core/services/party/party.service';
import { PlaybackQueueService } from '../../core/services/playback-queue.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { PlayerSettingsService } from '../../core/services/player-settings.service';
import { PlayerStateService } from '../../core/services/player-state.service';
import { ToastService } from '../../core/services/toast.service';
import { QueueController } from './queue-controller';

function setup(isLocal: boolean) {
  const session = { partyActive: signal(false), isLocal: () => isLocal, play: vi.fn(async () => 'cast') };
  const stub = (token: unknown) => ({ provide: token, useValue: {} });
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      QueueController,
      PlaybackQueueService,
      PlayerStateService,
      { provide: PlaybackSession, useValue: session },
      { provide: PartyService, useValue: { party: () => null, drives: () => false } },
      { provide: Router, useValue: { navigate: vi.fn(), navigateByUrl: vi.fn() } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
      stub(PlayerSettingsService),
      stub(CastService),
      stub(DeviceService),
      stub(MediaService),
      stub(StreamingApiService),
      stub(NavbarService),
      stub(ToastService),
      stub(LikesApiService),
    ],
  });
  const ctl = TestBed.inject(QueueController);
  ctl.attach({
    reloadingStream: () => false,
    preRollActive: () => false,
    hasEngine: () => false,
    isOfflinePlayback: () => false,
    clearEdlEnded: () => {},
  } as never);
  const queue = TestBed.inject(PlaybackQueueService);
  queue.start(
    [
      { mediaId: 1, episodeId: 1, mediaFileId: 11, title: 'a' },
      { mediaId: 1, episodeId: 2, mediaFileId: 12, title: 'b' },
    ],
    0,
    { source: 'series', sourceId: 1, autoplay: false },
  );
  return { ctl, session, queue };
}

describe('QueueController while another output plays', () => {
  it('plays the picked item on that output without opening the player route', async () => {
    const { ctl, session, queue } = setup(false);
    await ctl.playQueueItem(1);
    expect(queue.index()).toBe(1);
    expect(session.play).toHaveBeenCalledWith(
      { fileId: 12, mediaId: 1, episodeId: 2 },
      { fromStart: true, expand: false },
    );
  });

  it('follows the item an output switched to', () => {
    const { ctl, queue } = setup(false);
    ctl.followItem(1, 2);
    expect(queue.index()).toBe(1);
  });
});
