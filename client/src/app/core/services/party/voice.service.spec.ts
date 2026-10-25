import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PartyApiService } from '../api/party-api.service';
import { DeviceService } from '../device.service';
import { SseService } from '../sse.service';
import { ToastService } from '../toast.service';
import { PartyService } from './party.service';
import { VoiceService } from './voice.service';

function setup() {
  const rejoined = new Subject<void>();
  const api = { voice: vi.fn().mockResolvedValue(undefined) };
  TestBed.configureTestingModule({
    providers: [
      VoiceService,
      { provide: PartyApiService, useValue: api },
      { provide: PartyService, useValue: { party: signal({ id: 7 }), members: signal([]), rejoined, onActionError: vi.fn() } },
      { provide: SseService, useValue: { partyEvents: new Subject(), targetId: signal('dev'), connected: signal(true) } },
      { provide: ToastService, useValue: { error: vi.fn() } },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
      { provide: DeviceService, useValue: { isTv: () => false } },
    ],
  });
  return { voice: TestBed.inject(VoiceService), api, rejoined };
}

describe('VoiceService rejoin', () => {
  it('tells the server it is still in voice, with its mute state', async () => {
    const { voice, api, rejoined } = setup();
    voice.joined.set(true);
    rejoined.next();
    await Promise.resolve();
    expect(api.voice).toHaveBeenCalledWith(7, 'dev', true, true);
  });

  it('stays quiet when this device was not in voice', async () => {
    const { api, rejoined, voice } = setup();
    expect(voice.joined()).toBe(false);
    rejoined.next();
    await Promise.resolve();
    expect(api.voice).not.toHaveBeenCalled();
  });
});
