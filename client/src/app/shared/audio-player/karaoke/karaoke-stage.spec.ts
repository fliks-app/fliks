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

function remoteOutput(mode: string, level: number) {
  return { stemMode: signal(mode), vocalLevel: signal(level), stemsAvailable: signal(true), pitch: signal(0), position: signal(0), duration: signal(0), playing: signal(false), buffering: signal(false), rate: signal(1), setStemMode: vi.fn(), setVocalLevel: vi.fn(), setPitch: vi.fn() };
}

function create(output?: ReturnType<typeof remoteOutput>, opts: { canShiftKey?: boolean; party?: object } = {}) {
  const audio = {
    canShiftKey: signal(opts.canShiftKey ?? true),
    stemMode: signal('original'),
    vocalLevel: signal(0),
    stemsAvailable: signal(true),
    pitch: signal(0),
    position: signal(0),
    duration: signal(0),
    playing: signal(false),
    buffering: signal(false),
    rate: signal(1),
    setStemMode: vi.fn(),
    setVocalLevel: vi.fn(),
    setPitch: vi.fn(),
  };
  const karaoke = {
    canSing: true,
    singing: signal(false),
    starting: signal(false),
    micIssue: signal(null),
    difficulty: signal('medium'),
    latencyMs: signal(0),
    status: signal({ pitchShift: true }),
    board: signal(null),
    store: { singers: () => [], frames: () => [] },
    mediaMs: () => 0,
    results: () => [],
    finish: vi.fn(),
    stopSinging: vi.fn(),
    startSinging: vi.fn(),
    setDifficulty: vi.fn(),
    dismissBoard: vi.fn(),
    nudgeLatency: vi.fn(),
    setLatency: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: AudioPlayerService, useValue: audio },
      { provide: KaraokeService, useValue: karaoke },
      { provide: KaraokeRelayService, useValue: { open: vi.fn(), close: vi.fn() } },
      { provide: PartyService, useValue: { active: signal(false), isHost: signal(false), programme: signal([]), item: signal(null), userName: () => '', ...opts.party } },
      { provide: DeviceService, useValue: { isTv: signal(false), isTouch: signal(false), isPhone: signal(false) } },
    ],
  });
  const f = TestBed.createComponent(KaraokeStageComponent);
  f.componentRef.setInput('doc', { offset: 0, line: [], cueLine: [] } as unknown as StructuredLyrics);
  if (output) f.componentRef.setInput('output', output);
  f.detectChanges();
  return { f, audio, karaoke, el: f.nativeElement as HTMLElement };
}

describe('KaraokeStageComponent mix bar', () => {
  beforeEach(() => localStorage.removeItem('fliks.karaoke.mix'));
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

  it('rests the slider at the end of the preset and returns to the guide level on Guide', () => {
    const { f, el, audio } = create();
    const slider = el.querySelector('[data-testid="karaoke-vocal-level"]') as HTMLInputElement;
    const at = (mode: string) => {
      (audio.stemMode as unknown as { set(v: string): void }).set(mode);
      f.detectChanges();
      return slider.value;
    };
    slider.value = '60';
    slider.dispatchEvent(new Event('input'));
    expect(at('instrumental')).toBe('0');
    expect(at('original')).toBe('100');
    expect(at('guide')).toBe('60');
  });

  it('reads and drives the displayed output in remote view', () => {
    const { f, el, audio } = create();
    audio.setStemMode.mockClear();
    const out = { stemMode: signal('guide'), vocalLevel: signal(0.3), stemsAvailable: signal(true), pitch: signal(2), position: signal(0), duration: signal(0), playing: signal(false), buffering: signal(false), rate: signal(1), setStemMode: vi.fn(), setVocalLevel: vi.fn(), setPitch: vi.fn() };
    f.componentRef.setInput('output', out);
    f.detectChanges();
    el.querySelector<HTMLButtonElement>('[data-testid="karaoke-mode-instrumental"]')!.click();
    expect(out.setStemMode).toHaveBeenCalledWith('instrumental');
    expect(audio.setStemMode).not.toHaveBeenCalled();
    expect(el.textContent).toContain('+2');
  });

  it('remembers the preset and restores it when the stage opens again', () => {
    const first = create();
    first.el.querySelector<HTMLButtonElement>('[data-testid="karaoke-mode-instrumental"]')!.click();
    TestBed.resetTestingModule();
    const again = create();
    again.f.detectChanges();
    expect(again.audio.setStemMode).toHaveBeenCalledWith('instrumental');
  });

  it("keeps a remote device's mix instead of applying this browser's preset", () => {
    localStorage.setItem('fliks.karaoke.mix', JSON.stringify({ mode: 'instrumental', guide: 0.5 }));
    const out = remoteOutput('guide', 0.3);
    const { audio } = create(out);
    expect(out.setStemMode).not.toHaveBeenCalled();
    expect(audio.setStemMode).not.toHaveBeenCalled();
  });

  it("shows the remote device's guide level on the slider and follows it", () => {
    const out = remoteOutput('guide', 0.3);
    const { f, el } = create(out);
    const slider = el.querySelector('[data-testid="karaoke-vocal-level"]') as HTMLInputElement;
    expect(slider.value).toBe('30');
    out.vocalLevel.set(0.7);
    f.detectChanges();
    expect(slider.value).toBe('70');
  });

  it('restores the guide level with Guide', () => {
    const first = create();
    const slider = first.el.querySelector('[data-testid="karaoke-vocal-level"]') as HTMLInputElement;
    slider.value = '60';
    slider.dispatchEvent(new Event('input'));
    TestBed.resetTestingModule();
    const again = create();
    again.f.detectChanges();
    expect(again.audio.setStemMode).toHaveBeenCalledWith('guide');
    expect(again.audio.setVocalLevel).toHaveBeenLastCalledWith(0.6);
  });

  it('starts on Instrumental the first time', () => {
    const { audio } = create();
    expect(audio.setStemMode).toHaveBeenCalledWith('instrumental');
  });

  it('gathers quick taps on the key into one reopen at the target key', () => {
    vi.useFakeTimers();
    const { f, el, audio } = create();
    const up = el.querySelector<HTMLButtonElement>('[aria-label="karaoke.key_up"]')!;
    up.click();
    up.click();
    f.detectChanges();
    expect(el.querySelector('[data-testid="karaoke-key"]')!.textContent).toContain('+2');
    expect(audio.setPitch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(audio.setPitch).toHaveBeenCalledTimes(1);
    expect(audio.setPitch).toHaveBeenCalledWith(2);
    vi.useRealTimers();
  });

  it('disables the key with its reason on an output that cannot shift it', () => {
    const { el } = create(undefined, { canShiftKey: false });
    expect(el.querySelector<HTMLButtonElement>('[aria-label="karaoke.key_up"]')!.disabled).toBe(true);
    expect(el.querySelector('[data-testid="karaoke-key-hint"]')!.textContent).toContain('karaoke.key_not_here');
  });

  it('lists the next programme rows with their singers on the party display', () => {
    const row = (itemId: number, title: string, addedBy: number) => ({ mediaId: 1, itemId, title, addedBy, hidden: false });
    const { el } = create(undefined, {
      party: {
        active: signal(true),
        isHost: signal(true),
        item: signal({ mediaId: 1, itemId: 1 }),
        programme: signal([row(1, 'Now', 5), row(2, 'Next', 6), row(3, 'Later', 5)]),
        userName: (id: number) => (id === 6 ? 'Bo' : 'Ana'),
      },
    });
    const text = el.querySelector('[data-testid="karaoke-up-next"]')!.textContent!;
    expect(text).toContain('Next');
    expect(text).toContain('Bo');
    expect(text).not.toContain('Now');
  });
});
