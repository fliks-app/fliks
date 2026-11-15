import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApiService } from '../../../core/services/api/karaoke-api.service';
import { LyricsApiService } from '../../../core/services/api/lyrics-api.service';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { AuthService } from '../../../core/services/auth.service';
import { SseService } from '../../../core/services/sse.service';
import { LyricsPanelComponent } from './lyrics-panel';

const none = { state: 'none', fileId: 1, stems: {}, lyrics: false, melody: false, cdg: false };

async function create() {
  const karaoke = {
    status: vi.fn(async () => ({ ready: true })),
    itemState: vi.fn(async () => none),
    prepare: vi.fn(async () => ({ ...none, state: 'queued' })),
  };
  const audio = {
    musicMode: signal(true),
    track: signal({ itemId: 7 }),
    stemsNative: false,
    stemMode: signal('original'),
    stemsAvailable: signal(true),
    vocalLevel: signal(1),
    position: signal(0),
    playing: signal(false),
    rate: signal(1),
    refreshStems: vi.fn(),
    setStemMode: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: KaraokeApiService, useValue: karaoke },
      { provide: LyricsApiService, useValue: { get: async () => ({ structuredLyrics: [] }) } },
      { provide: AudioPlayerService, useValue: audio },
      { provide: AuthService, useValue: { hasPermission: () => true } },
      { provide: SseService, useValue: { karaokeEvents: new Subject() } },
    ],
  });
  const f = TestBed.createComponent(LyricsPanelComponent);
  f.componentRef.setInput('itemId', 7);
  f.detectChanges();
  await vi.waitFor(() => expect(karaoke.status).toHaveBeenCalled());
  await f.whenStable();
  f.detectChanges();
  return { f, karaoke, audio };
}

describe('LyricsPanelComponent karaoke', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('switches karaoke on in place of the lyrics and prepares an unprepared track', async () => {
    const { f, karaoke } = await create();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="karaoke-prepare"]')).toBeNull();
    (el.querySelector('[data-testid="karaoke-toggle"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(karaoke.itemState).toHaveBeenCalled());
    await f.whenStable();
    f.detectChanges();
    (el.querySelector('[data-testid="karaoke-prepare"]') as HTMLButtonElement).click();
    expect(karaoke.prepare).toHaveBeenCalledWith(7, {});
  });

  it('returns to the original mix when karaoke is switched off', async () => {
    const { f, audio } = await create();
    const toggle = (f.nativeElement as HTMLElement).querySelector('[data-testid="karaoke-toggle"]') as HTMLButtonElement;
    toggle.click();
    f.detectChanges();
    expect(audio.setStemMode).not.toHaveBeenCalled();
    toggle.click();
    expect(audio.setStemMode).toHaveBeenCalledWith('original');
  });
});
