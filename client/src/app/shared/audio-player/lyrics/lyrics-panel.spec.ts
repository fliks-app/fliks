import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApiService } from '../../../core/services/api/karaoke-api.service';
import { LyricsApiService } from '../../../core/services/api/lyrics-api.service';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { AuthService } from '../../../core/services/auth.service';
import { DeviceService } from '../../../core/services/device.service';
import { SseService } from '../../../core/services/sse.service';
import { LyricsPanelComponent } from './lyrics-panel';

const none = { state: 'none', fileId: 1, stems: {}, lyrics: false, melody: false, cdg: false };

async function create(structuredLyrics: unknown[] = [], output?: unknown, state?: unknown) {
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
      { provide: DeviceService, useValue: { isTv: signal(false) } },
      { provide: SseService, useValue: { karaokeEvents: new Subject() } },
    ],
  });
  const f = TestBed.createComponent(LyricsPanelComponent);
  f.componentRef.setInput('itemId', 7);
  if (state) karaoke.itemState.mockResolvedValue(state as typeof none);
  if (output) f.componentRef.setInput('output', output);
  f.detectChanges();
  await vi.waitFor(() => expect(karaoke.status).toHaveBeenCalled());
  if (!output || (output as { supports(): boolean }).supports()) await vi.waitFor(() => expect(karaoke.itemState).toHaveBeenCalled());
  await f.whenStable();
  f.detectChanges();
  return { f, karaoke, audio, panel: f.componentInstance as unknown as { singKind(): string | null; sing(): void; stage(): boolean; layers(): unknown[] } };
}

describe('LyricsPanelComponent karaoke', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('prepares an unprepared track from the Sing button', async () => {
    const { panel, karaoke } = await create();
    expect(panel.singKind()).toBe('prepare');
    panel.sing();
    expect(karaoke.prepare).toHaveBeenCalledWith(7, {});
  });

  it('retries a failed track and does nothing while it runs', async () => {
    const failed = await create([], undefined, { ...none, state: 'failed' });
    expect(failed.panel.singKind()).toBe('retry');
    failed.panel.sing();
    expect(failed.karaoke.prepare).toHaveBeenCalled();
    TestBed.resetTestingModule();
    const running = await create([], undefined, { ...none, state: 'running', stage: 'align', progress: 50 });
    expect(running.panel.singKind()).toBe('running');
    running.panel.sing();
    expect(running.karaoke.prepare).not.toHaveBeenCalled();
    const el = running.f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="karaoke-bubble"]')!.textContent).toContain('karaoke.preparing_pct');
  });

  it('enters and leaves karaoke on a ready track, back to the original mix', async () => {
    const { f, panel, audio } = await create([], undefined, { ...none, state: 'ready' });
    expect(panel.singKind()).toBe('enter');
    panel.sing();
    f.detectChanges();
    expect(panel.stage()).toBe(true);
    expect(panel.singKind()).toBe('exit');
    panel.sing();
    expect(panel.stage()).toBe(false);
    expect(audio.setStemMode).toHaveBeenCalledWith('original');
  });

  it('sends the return to the original mix to the displayed output', async () => {
    const out = { musicMode: signal(true), track: signal({ itemId: 7 }), position: signal(0), playing: signal(false), rate: signal(1), supports: () => true, setStemMode: vi.fn() };
    const { panel, audio } = await create([], out, { ...none, state: 'ready' });
    panel.sing();
    panel.sing();
    expect(out.setStemMode).toHaveBeenCalledWith('original');
    expect(audio.setStemMode).not.toHaveBeenCalled();
  });

  it('has no header row and shows the plain text, or the only text when it is word-synced', async () => {
    const doc = (id: number, value: string, cue: boolean) => ({
      id, kind: 'main', lang: 'en', synced: true, offset: 0, source: 'user', preferred: false,
      line: [{ start: 0, value }],
      ...(cue ? { cueLine: [{ index: 0, start: 0, end: 500, value, cue: [{ start: 0, end: 500, value, byteStart: 0, byteEnd: value.length }] }] } : {}),
    });
    const both = await create([doc(1, 'wordsync', true), doc(2, 'plain', false)]);
    const el = both.f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lyrics-lines"]')!.textContent).toContain('plain');
    expect(el.querySelector('[data-testid="lyrics-lines"]')!.textContent).not.toContain('wordsync');
    expect(el.querySelectorAll('button[aria-pressed]').length).toBe(0);
    TestBed.resetTestingModule();
    const only = await create([doc(1, 'wordsync', true)]);
    expect((only.f.nativeElement as HTMLElement).querySelector('[data-testid="lyrics-lines"]')!.textContent).toContain('wordsync');
  });

  it('hides Sing in remote view when the device cannot apply stems', async () => {
    const remote = (can: boolean) => ({ musicMode: signal(true), track: signal({ itemId: 7 }), position: signal(0), playing: signal(false), rate: signal(1), supports: () => can, setStemMode: vi.fn() });
    const on = await create([], remote(true));
    expect((on.f.componentInstance as unknown as { karaokeOn(): boolean }).karaokeOn()).toBe(true);
    TestBed.resetTestingModule();
    const off = await create([], remote(false));
    expect((off.f.componentInstance as unknown as { karaokeOn(): boolean }).karaokeOn()).toBe(false);
  });
});
