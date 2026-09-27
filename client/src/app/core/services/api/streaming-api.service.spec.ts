import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { StreamingApiService, PlaybackInfoResponse } from './streaming-api.service';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { CastService } from '../cast.service';
import { BrowserDeviceProfileService } from '../browser-device-profile.service';
import { SseService } from '../sse.service';

function pi(playMethod: PlaybackInfoResponse['playMethod'], playUrl: string) {
  return { playMethod, playUrl } as Pick<PlaybackInfoResponse, 'playMethod' | 'playUrl'>;
}

describe('StreamingApiService.buildPlayUrl / buildAbsolutePlayUrl', () => {
  let service: StreamingApiService;
  let isNative = false;

  beforeEach(() => {
    isNative = false;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { playbackToken: null } },
        {
          provide: ServerConfigService,
          useValue: {
            get isNative() { return isNative; },
            resolveUrl: (path: string) => `capacitor://localhost${path}`,
          },
        },
        { provide: CastService, useValue: { castStreamBaseUrl: () => '' } },
        {
          provide: BrowserDeviceProfileService,
          useValue: { getProfile: () => ({ deviceType: 'desktop' }) },
        },
        { provide: SseService, useValue: { connectionId: () => null } },
      ],
    });
    service = TestBed.inject(StreamingApiService);
  });

  it('a DirectStream decision carries remux=1 and never startQuality', () => {
    const url = service.buildPlayUrl(
      pi('DirectStream', '/api/stream/1/master.m3u8?token=abc&remux=1'),
      { sid: 'sid1', startAt: 30, startQuality: 'original' },
    );
    expect(url).toContain('remux=1');
    expect(url).not.toContain('startQuality');
    expect(url).toContain('sid=sid1');
    expect(url).toContain('startAt=30');
    expect(url).toContain('device=desktop');
  });

  it('a Transcode decision keeps startQuality and carries no remux flag', () => {
    const url = service.buildPlayUrl(
      pi('Transcode', '/api/stream/1/master.m3u8?token=abc'),
      { sid: 'sid1', startQuality: '720p' },
    );
    expect(url).toContain('startQuality=720p');
    expect(url).not.toContain('remux=1');
  });

  it('DirectPlay ignores startQuality and only appends sid', () => {
    const url = service.buildPlayUrl(
      pi('DirectPlay', '/api/stream/1?token=abc'),
      { sid: 'sid1', startQuality: 'original' },
    );
    expect(url).toBe('/api/stream/1?token=abc&sid=sid1');
  });

  it('resolves an absolute URL for native even for a DirectStream decision', () => {
    isNative = true;
    const url = service.buildPlayUrl(
      pi('DirectStream', '/api/stream/1/master.m3u8?token=abc&remux=1'),
      {},
    );
    expect(url.startsWith('capacitor://localhost/api/stream/1/master.m3u8')).toBe(true);
    expect(url).toContain('remux=1');
  });

  it('buildAbsolutePlayUrl replaces the sender token with the Cast token and keeps remux=1', () => {
    const { url, contentType } = service.buildAbsolutePlayUrl(
      pi('DirectStream', '/api/stream/1/master.m3u8?token=sender-secret&remux=1'),
      'cast-token',
      { sid: 'sid1', startAt: 12, startQuality: 'original' },
    );
    expect(url).not.toContain('sender-secret');
    expect(url).toContain('token=cast-token');
    expect(url).toContain('remux=1');
    expect(url).not.toContain('startQuality');
    expect(contentType).toBe('application/x-mpegurl');
  });

  it('buildAbsolutePlayUrl keeps startQuality for a Transcode decision', () => {
    const { url } = service.buildAbsolutePlayUrl(
      pi('Transcode', '/api/stream/1/master.m3u8?token=sender-secret'),
      'cast-token',
      { startQuality: '1080p' },
    );
    expect(url).toContain('startQuality=1080p');
    expect(url).not.toContain('remux=1');
  });
});
