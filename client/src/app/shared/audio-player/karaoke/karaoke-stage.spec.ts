import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StructuredLyrics } from '../../../core/services/api/lyrics.models';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { DeviceService } from '../../../core/services/device.service';
import { KaraokeRelayService } from '../../../core/services/karaoke/karaoke-relay.service';
import { KaraokeService } from '../../../core/services/karaoke/karaoke.service';
import { PartyService } from '../../../core/services/party/party.service';
import { KaraokeStageComponent } from './karaoke-stage';

function create() {
  const audio = {
    stemMode: signal('original'),
    vocalLevel: signal(0),
    stemsAvailable: signal(true),
    pitch: signal(0),
    position: signal(0),
    duration: signal(0),
    playing: signal(false),
    rate: signal(1),
    setStemMode: vi.fn(),
    setVocalLevel: vi.fn(),
    setPitch: vi.fn(),
  };
  const karaoke = {
    canSing: true,
    singing: signal(false),
    micIssue: signal(null),
    difficulty: signal('medium'),
    latencyMs: signal(0),
    board: signal(null),
    store: { singers: () => [], frames: () => [] },
    mediaMs: () => 0,
    results: () => [],
    finish: vi.fn(),
    stopSinging: vi.fn(),
    startSinging: vi.fn(),
    setDifficulty: vi.fn(),
    dismissBoard: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: AudioPlayerService, useValue: audio },
      { provide: KaraokeService, useValue: karaoke },
      { provide: KaraokeRelayService, useValue: { open: vi.fn(), close: vi.fn() } },
      { provide: PartyService, useValue: { active: signal(false), isHost: signal(false) } },
      { provide: DeviceService, useValue: { isTv: signal(false), isTouch: signal(false) } },
    ],
  });
  const f = TestBed.createComponent(KaraokeStageComponent);
  f.componentRef.setInput('doc', { offset: 0, line: [], cueLine: [] } as unknown as StructuredLyrics);
  f.detectChanges();
  return { f, audio, el: f.nativeElement as HTMLElement };
}

describe('KaraokeStageComponent mix bar', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('plays the original mix on Original and the stems on the other presets', () => {
    const { el, audio } = create();
    (el.querySelector('[data-testid="karaoke-mode-instrumental"]') as HTMLButtonElement).click();
    expect(audio.setStemMode).toHaveBeenLastCalledWith('instrumental');
    (el.querySelector('[data-testid="karaoke-mode-original"]') as HTMLButtonElement).click();
    expect(audio.setStemMode).toHaveBeenLastCalledWith('original');
  });

  it('selects Guide at the dragged level, and Guide restores the last level', () => {
    const { el, audio } = create();
    const slider = el.querySelector('[data-testid="karaoke-vocal-level"]') as HTMLInputElement;
    slider.value = '60';
    slider.dispatchEvent(new Event('input'));
    expect(audio.setStemMode).toHaveBeenLastCalledWith('guide');
    expect(audio.setVocalLevel).toHaveBeenLastCalledWith(0.6);
    (el.querySelector('[data-testid="karaoke-mode-instrumental"]') as HTMLButtonElement).click();
    (el.querySelector('[data-testid="karaoke-mode-guide"]') as HTMLButtonElement).click();
    expect(audio.setVocalLevel).toHaveBeenLastCalledWith(0.6);
  });
});
