import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { BrowserDeviceProfileService } from '../browser-device-profile.service';
import { CastService } from '../cast.service';
import { AuthService } from '../auth.service';
import { SERVER_SINCE, ServerVersionService } from '../server-version.service';
import { ServerConfigService } from '../server-config.service';
import { SseService } from '../sse.service';
import { StreamingApiService } from './streaming-api.service';

describe('StreamingApiService.getKeyframes', () => {
  let http: HttpTestingController;
  let service: StreamingApiService;
  let supports: (since: string) => boolean;

  beforeEach(() => {
    supports = () => true;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: {} },
        { provide: ServerConfigService, useValue: {} },
        { provide: CastService, useValue: {} },
        { provide: BrowserDeviceProfileService, useValue: {} },
        { provide: SseService, useValue: {} },
        { provide: ServerVersionService, useValue: { supportsWhenKnown: async (s: string) => supports(s) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(StreamingApiService);
  });

  afterEach(() => http.verify());

  it('makes no request to a server older than the keyframes release', async () => {
    supports = (since) => since !== SERVER_SINCE.keyframes;
    expect(await service.getKeyframes(5)).toEqual([]);
  });

  it('asks a recent server without the error toast', async () => {
    const result = service.getKeyframes(5);
    await new Promise((r) => setTimeout(r));
    const req = http.expectOne('/api/stream/5/keyframes');
    expect(req.request.context.get(SKIP_ERROR_TOAST)).toBe(true);
    req.flush({ keyframes: [0, 2.5] });
    expect(await result).toEqual([0, 2.5]);
  });
});
