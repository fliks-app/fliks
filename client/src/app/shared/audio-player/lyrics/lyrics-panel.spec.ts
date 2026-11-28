import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApiService } from '../../../core/services/api/karaoke-api.service';
import type { KaraokeItemState } from '../../../core/services/api/karaoke.models';
import { LyricsApiService } from '../../../core/services/api/lyrics-api.service';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { AuthService } from '../../../core/services/auth.service';
import { DeviceService } from '../../../core/services/device.service';
import { KaraokeService } from '../../../core/services/karaoke/karaoke.service';
import { LyricsPanelComponent } from './lyrics-panel';

const none: KaraokeItemState = { state: 'none', fileId: 1, stems: {}, lyrics: false, melody: false, cdg: false };

async function create(structuredLyrics: unknown[] = [], state: KaraokeItemState | null = null) {
  const session = {
    stage: signal(false),
    itemId: signal<number | undefined>(7),
    itemState: signal(state),
    singKind: signal<string | null>(null),
    prepPct: signal(40),
    busy: signal(false),
    readyFlash: signal(false),
    cdgFile: signal<number | null>(state?.cdg ? state.fileId : null),
    prepared: new Subject<number>(),
    singing: signal(true),
    starting: signal(false),
    stopSinging: vi.fn(),
    prepare: vi.fn(),
    remove: vi.fn(),
    enter: vi.fn(),
  };
  const lyrics = { get: vi.fn(async () => ({ structuredLyrics })), patch: vi.fn(async () => undefined) };
  const audio = { musicMode: signal(true), track: signal({ itemId: 7 }), position: signal(0), playing: signal(false), buffering: signal(false), rate: signal(1) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({ karaoke: { failure: { model_missing: 'no model' } } }) } } }),
      { provide: KaraokeService, useValue: session },
      { provide: KaraokeApiService, useValue: { cdgUrl: () => '/cdg' } },
      { provide: LyricsApiService, useValue: lyrics },
      { provide: AudioPlayerService, useValue: audio },
      { provide: AuthService, useValue: { hasPermission: () => true } },
      { provide: DeviceService, useValue: { isTv: signal(false) } },
    ],
  });
  const f = TestBed.createComponent(LyricsPanelComponent);
  f.componentRef.setInput('itemId', 7);
  f.detectChanges();
  await vi.waitFor(() => expect(lyrics.get).toHaveBeenCalled());
  await f.whenStable();
  f.detectChanges();
  return { f, session, lyrics, el: f.nativeElement as HTMLElement };
}

describe('LyricsPanelComponent karaoke', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('names the running stage, and waits without a percentage while queued', async () => {
    const running = await create([], { ...none, state: 'running', stage: 'align', progress: 50 });
    expect(running.el.querySelector('[data-testid="karaoke-bubble"]')!.textContent).toContain('karaoke.stage_align');
    running.session.itemState.set({ ...none, state: 'queued' });
    running.f.detectChanges();
    const queued = running.el.querySelector('[data-testid="karaoke-bubble"]')!.textContent!;
    expect(queued).toContain('karaoke.queued');
    expect(queued).not.toContain('%');
  });

  it('shows why a preparation failed, for touch and TV users too', async () => {
    const { el, session, f } = await create([], { ...none, state: 'failed', error: { code: 'model_missing' } });
    session.singKind.set('retry');
    f.detectChanges();
    expect(el.querySelector('[data-testid="karaoke-failed"]')!.textContent).toContain('no model');
  });

  it('keeps the mic across tracks and stops it with the stage', async () => {
    const { f, session } = await create();
    session.stage.set(true);
    f.detectChanges();
    session.stopSinging.mockClear();
    f.componentRef.setInput('itemId', 8);
    f.detectChanges();
    await f.whenStable();
    expect(session.stopSinging).not.toHaveBeenCalled();
    session.stage.set(false);
    f.detectChanges();
    await f.whenStable();
    expect(session.stopSinging).toHaveBeenCalled();
  });

  it('draws the MP3+G graphics of a track without lyrics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const { el } = await create([], { ...none, cdg: true });
    expect(el.querySelector('[data-testid="karaoke-cdg"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="lyrics-empty"]')).toBeNull();
  });

  it('reloads the lyrics once a preparation of its track ends', async () => {
    const { session, lyrics } = await create();
    lyrics.get.mockClear();
    session.prepared.next(8);
    session.prepared.next(7);
    await vi.waitFor(() => expect(lyrics.get).toHaveBeenCalledTimes(1));
  });

  it('keeps a generated sync from the edit tools', async () => {
    const generated = { id: 4, kind: 'main', lang: 'en', synced: true, offset: 0, source: 'generated', reviewed: false, preferred: false, line: [{ start: 0, value: 'x' }] };
    const { f, el, lyrics } = await create([generated]);
    f.componentRef.setInput('edit', true);
    f.detectChanges();
    el.querySelector<HTMLButtonElement>('[data-testid="lyrics-keep"]')!.click();
    await vi.waitFor(() => expect(lyrics.patch).toHaveBeenCalledWith(4, { reviewed: true }));
  });

  it('has no header row and shows the plain text, or the only text when it is word-synced', async () => {
    const doc = (id: number, value: string, cue: boolean) => ({
      id, kind: 'main', lang: 'en', synced: true, offset: 0, source: 'user', preferred: false,
      line: [{ start: 0, value }],
      ...(cue ? { cueLine: [{ index: 0, start: 0, end: 500, value, cue: [{ start: 0, end: 500, value, byteStart: 0, byteEnd: value.length }] }] } : {}),
    });
    const both = await create([doc(1, 'wordsync', true), doc(2, 'plain', false)]);
    expect(both.el.querySelector('[data-testid="lyrics-lines"]')!.textContent).toContain('plain');
    expect(both.el.querySelector('[data-testid="lyrics-lines"]')!.textContent).not.toContain('wordsync');
    expect(both.el.querySelectorAll('button[aria-pressed]').length).toBe(0);
    TestBed.resetTestingModule();
    const only = await create([doc(1, 'wordsync', true)]);
    expect(only.el.querySelector('[data-testid="lyrics-lines"]')!.textContent).toContain('wordsync');
  });
});
