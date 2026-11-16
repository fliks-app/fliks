import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      { provide: PartyService, useValue: { active: signal(false), isHost: signal(false), singerQueue: signal([]), members: () => [], party: () => null } },
      { provide: DeviceService, useValue: { isTv: signal(false), isTouch: signal(false), isPhone: signal(false) } },
    ],
  });
  const f = TestBed.createComponent(KaraokeStageComponent);
  f.componentRef.setInput('doc', { offset: 0, line: [], cueLine: [] } as unknown as StructuredLyrics);
  f.detectChanges();
  return { f, audio, el: f.nativeElement as HTMLElement };
}

describe('KaraokeStageComponent voice level', () => {
  beforeEach(() => localStorage.removeItem('fliks.karaoke.level'));
  afterEach(() => TestBed.resetTestingModule());

  const slider = (el: HTMLElement) => el.querySelector('[data-testid="karaoke-vocal-level"]') as HTMLInputElement;
  const drag = (el: HTMLElement, v: string) => {
    slider(el).value = v;
    slider(el).dispatchEvent(new Event('input'));
  };

  it('plays the stems at the dragged level, leaving the original mix first', () => {
    const { el, audio } = create();
    drag(el, '60');
    expect(audio.setStemMode).toHaveBeenLastCalledWith('guide');
    expect(audio.setVocalLevel).toHaveBeenLastCalledWith(0.6);
  });

  it('goes back to the original mix at 100 and to silence of the voice at 0', () => {
    const { el, audio } = create();
    drag(el, '100');
    expect(audio.setStemMode).toHaveBeenLastCalledWith('original');
    drag(el, '0');
    expect(audio.setVocalLevel).toHaveBeenLastCalledWith(0);
  });

  it('reads the slider from the mode and the vocal level', () => {
    const { f, el, audio } = create();
    expect(slider(el).value).toBe('100');
    (audio.stemMode as unknown as { set(v: string): void }).set('guide');
    (audio.vocalLevel as unknown as { set(v: number): void }).set(0.3);
    f.detectChanges();
    expect(slider(el).value).toBe('30');
  });

  it('reads and drives the displayed output in remote view', () => {
    const { f, el, audio } = create();
    const out = { stemMode: signal('guide'), vocalLevel: signal(0.3), stemsAvailable: signal(true), pitch: signal(2), position: signal(0), duration: signal(0), playing: signal(false), rate: signal(1), setStemMode: vi.fn(), setVocalLevel: vi.fn(), setPitch: vi.fn() };
    f.componentRef.setInput('output', out);
    f.detectChanges();
    drag(el, '40');
    expect(out.setVocalLevel).toHaveBeenCalledWith(0.4);
    expect(audio.setVocalLevel).not.toHaveBeenCalled();
  });

  it('restores the saved level when the stage opens again', () => {
    const first = create();
    drag(first.el, '60');
    TestBed.resetTestingModule();
    const again = create();
    again.f.detectChanges();
    expect(again.audio.setVocalLevel).toHaveBeenLastCalledWith(0.6);
  });

  it('has no mode buttons and no queue button outside a party', () => {
    const { el } = create();
    expect(el.querySelector('[data-testid="karaoke-mode-guide"]')).toBeNull();
    expect(el.querySelector('[data-testid="karaoke-queue-open"]')).toBeNull();
  });
});
