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

const ready = { state: 'ready', fileId: 1, stems: {}, lyrics: true, melody: true, cdg: false };

async function create(docs: unknown[] = []) {
  const lyrics = { get: vi.fn(async () => ({ structuredLyrics: docs })), patch: vi.fn(async () => ({})) };
  const karaoke = {
    status: vi.fn(async () => ({ ready: true })),
    itemState: vi.fn(async () => ready),
    prepare: vi.fn(async () => ({ ...ready, state: 'queued' })),
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
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: KaraokeApiService, useValue: karaoke },
      { provide: LyricsApiService, useValue: lyrics },
      { provide: AudioPlayerService, useValue: audio },
      { provide: AuthService, useValue: { hasPermission: () => true } },
      { provide: SseService, useValue: { karaokeEvents: new Subject() } },
    ],
  });
  const f = TestBed.createComponent(LyricsPanelComponent);
  f.componentRef.setInput('itemId', 7);
  f.detectChanges();
  await vi.waitFor(() => expect(karaoke.itemState).toHaveBeenCalled());
  await f.whenStable();
  f.detectChanges();
  return { f, karaoke, lyrics };
}

describe('LyricsPanelComponent recompute', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('offers the menu on a ready track and forces the asked part', async () => {
    const { f, karaoke } = await create();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="karaoke-recompute"]')).not.toBeNull();
    (el.querySelector('[data-testid="karaoke-recompute-melody"]') as HTMLButtonElement).click();
    expect(karaoke.prepare).toHaveBeenLastCalledWith(7, { align: false, melody: true, force: true });
    (el.querySelector('[data-testid="karaoke-recompute-sync"]') as HTMLButtonElement).click();
    expect(karaoke.prepare).toHaveBeenLastCalledWith(7, { align: true, melody: true, force: true });
  });

  it('keeps the chosen document after saving a singer', async () => {
    const d = (id: number) => ({ id, kind: 'main', lang: 'en', source: 'user', synced: true, offset: 0, line: [{ start: 0, value: 'a' }] });
    const { f, lyrics } = await create([d(1), d(2)]);
    const c = f.componentInstance as unknown as { pick(id: number): void; setSinger(d: unknown, e: unknown): Promise<void>; main(): { id: number } };
    c.pick(2);
    await c.setSinger(d(2), { line: 0, choice: '1' });
    expect(lyrics.patch).toHaveBeenCalled();
    expect(lyrics.get).toHaveBeenCalledTimes(2);
    expect(c.main().id).toBe(2);
  });
});
