import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, expect, it } from 'vitest';
import { MarkersApiService } from './api/markers-api.service';
import { MediaService } from './api/media.service';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { RemotePlaybackTarget } from './remote-playback-target';
import { RemoteService, type RemoteNowPlaying } from './remote.service';
import { TrackManagerService } from './track-manager.service';

function setup(state: Partial<RemoteNowPlaying> | null, actions?: string[]) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: RemoteService,
        useValue: {
          targetState: signal(state),
          observedCan: (a: string) => !actions || actions.includes(a),
          observedTargetId: signal('tv#1'),
          interpolatedPosition: signal(0),
          isRemoting: signal(false),
          isObserving: signal(true),
          restarting: signal(false),
          targetOffline: signal(false),
          pendingAction: signal(null),
          awaitingFirstReport: signal(false),
        },
      },
      { provide: StreamingApiService, useValue: {} },
      { provide: MarkersApiService, useValue: {} },
      { provide: TrackManagerService, useValue: {} },
      { provide: MediaService, useValue: {} },
      { provide: SubtitlesApiService, useValue: {} },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  return TestBed.inject(RemotePlaybackTarget);
}

describe('RemotePlaybackTarget volume', () => {
  it('offers no volume before the device has reported', () => {
    expect(setup(null).canSetVolume()).toBe(false);
  });

  it('offers no volume to a device that reports it takes none', () => {
    expect(setup({ supportsVolume: false, volume: null }).canSetVolume()).toBe(false);
  });

  it('offers volume to a device that reports it, unless it refuses the commands', () => {
    expect(setup({ supportsVolume: true, volume: 0.5 }).canSetVolume()).toBe(true);
    TestBed.resetTestingModule();
    expect(setup({ supportsVolume: true, volume: 0.5 }, ['play', 'pause']).canSetVolume()).toBe(false);
  });
});
