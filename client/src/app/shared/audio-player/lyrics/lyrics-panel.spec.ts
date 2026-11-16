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

async function create(structuredLyrics: unknown[] = [], output?: unknown) {
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
      { provide: LyricsApiService, useValue: { get: async () => ({ structuredLyrics }) } },
      { provide: AudioPlayerService, useValue: audio },
      { provide: AuthService, useValue: { hasPermission: () => true } },
      { provide: SseService, useValue: { karaokeEvents: new Subject() } },
    ],
  });
  const f = TestBed.createComponent(LyricsPanelComponent);
  f.componentRef.setInput('itemId', 7);
  if (output) f.componentRef.setInput('output', output);
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

  it('shows the plain text in the lyrics view without a version picker, and the only text when it is word-synced', async () => {
    const doc = (id: number, value: string, cue: boolean) => ({
      id, kind: 'main', lang: 'en', synced: true, offset: 0, source: 'user', preferred: false,
      line: [{ start: 0, value }],
      ...(cue ? { cueLine: [{ index: 0, start: 0, end: 500, value, cue: [{ start: 0, end: 500, value, byteStart: 0, byteEnd: value.length }] }] } : {}),
    });
    const both = await create([doc(1, 'wordsync', true), doc(2, 'plain', false)]);
    const el = both.f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lyrics-lines"]')!.textContent).toContain('plain');
    expect(el.querySelector('[data-testid="lyrics-lines"]')!.textContent).not.toContain('wordsync');
    expect(el.querySelectorAll('button[aria-pressed]').length).toBe(1);
    TestBed.resetTestingModule();
    const only = await create([doc(1, 'wordsync', true)]);
    expect((only.f.nativeElement as HTMLElement).querySelector('[data-testid="lyrics-lines"]')!.textContent).toContain('wordsync');
  });

  it('offers karaoke in remote view only when the device applies stems', async () => {
    const remote = (can: boolean) => ({
      musicMode: signal(true),
      track: signal({ itemId: 7 }),
      position: signal(0),
      playing: signal(false),
      rate: signal(1),
      supports: () => can,
      setStemMode: vi.fn(),
    });
    const on = await create([], remote(true));
    const toggle = (on.f.nativeElement as HTMLElement).querySelector('[data-testid="karaoke-toggle"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    TestBed.resetTestingModule();
    const off = await create([], remote(false));
    const greyed = (off.f.nativeElement as HTMLElement).querySelector('[data-testid="karaoke-toggle"]') as HTMLButtonElement;
    expect(greyed.disabled).toBe(true);
    expect(greyed.parentElement!.getAttribute('data-tip')).toBe('karaoke.remote');
  });

  it('sends the return to the original mix to the displayed output', async () => {
    const out = {
      musicMode: signal(true),
      track: signal({ itemId: 7 }),
      position: signal(0),
      playing: signal(false),
      rate: signal(1),
      supports: () => true,
      setStemMode: vi.fn(),
    };
    const { f, audio } = await create([], out);
    const toggle = (f.nativeElement as HTMLElement).querySelector('[data-testid="karaoke-toggle"]') as HTMLButtonElement;
    toggle.click();
    toggle.click();
    expect(out.setStemMode).toHaveBeenCalledWith('original');
    expect(audio.setStemMode).not.toHaveBeenCalled();
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
