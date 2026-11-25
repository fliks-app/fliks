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

function setup(isLocal: boolean, host: Record<string, unknown> = {}) {
  const session = { partyActive: signal(false), isLocal: () => isLocal, output: () => undefined, play: vi.fn(async () => 'cast') };
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
      { provide: NavbarService, useValue: { markAsBackNavigation: vi.fn() } },
      stub(ToastService),
      stub(LikesApiService),
    ],
  });
  const ctl = TestBed.inject(QueueController);
  ctl.attach({
    preRollActive: () => false,
    hasEngine: () => false,
    isOfflinePlayback: () => false,
    clearEdlEnded: () => {},
    ...host,
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

describe('QueueController while a reload runs', () => {
  const inPlace = (reloadForEpisode: () => Promise<boolean>) => ({
    hasEngine: () => true,
    mediaId: () => 1,
    engineDuration: () => undefined,
    duration: () => 0,
    setBackdropUrl: () => {},
    reloadForEpisode,
  });

  const setupInPlace = (reloadForEpisode: () => Promise<boolean>) =>
    setup(true, inPlace(reloadForEpisode));

  it('playQueueItem switches without waiting for the running reload', async () => {
    const reloadForEpisode = vi.fn(async () => true);
    const { ctl, queue } = setupInPlace(reloadForEpisode);
    await ctl.playQueueItem(1);
    expect(queue.index()).toBe(1);
    expect(reloadForEpisode).toHaveBeenCalledExactlyOnceWith(12, 1, 2);
  });

  it('advance switches without waiting for the running reload', async () => {
    const reloadForEpisode = vi.fn(async () => true);
    const { ctl, queue } = setupInPlace(reloadForEpisode);
    await ctl.advance();
    expect(queue.index()).toBe(1);
    expect(reloadForEpisode).toHaveBeenCalledExactlyOnceWith(12, 1, 2);
  });

  it('openPartyItem returns what the switch returns', async () => {
    const item = { mediaId: 1, mediaFileId: 12, episodeId: 2 };
    const ok = setupInPlace(async () => true);
    expect(await ok.ctl.openPartyItem(item)).toBe(true);
    TestBed.resetTestingModule();
    const cut = setupInPlace(async () => false);
    expect(await cut.ctl.openPartyItem(item)).toBe(false);
  });
});

describe('QueueController at the natural end', () => {
  const ended = (opts: { index: number; autoPlayNext?: boolean; preRoll?: boolean; party?: boolean }) => {
    TestBed.overrideProvider(PlayerSettingsService, { useValue: { settings: () => ({ autoPlayNext: opts.autoPlayNext ?? true }) } });
    const close = vi.fn();
    const { ctl, session, queue } = setup(true, { close, preRollActive: () => !!opts.preRoll });
    session.partyActive.set(!!opts.party);
    queue.setIndex(opts.index);
    TestBed.inject(PlayerStateService).ended.set(true);
    ctl.autoAdvance();
    TestBed.resetTestingModule();
    return close;
  };

  it('closes the player when nothing follows', () => {
    expect(ended({ index: 1 })).toHaveBeenCalledOnce();
  });

  it('stays open when an item follows, autoplay or not', () => {
    expect(ended({ index: 0, autoPlayNext: false })).not.toHaveBeenCalled();
  });

  it('leaves a pre-roll and a party to pick what plays next', () => {
    expect(ended({ index: 1, preRoll: true })).not.toHaveBeenCalled();
    expect(ended({ index: 1, party: true })).not.toHaveBeenCalled();
  });
});
