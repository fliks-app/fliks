import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyService } from '../../../core/services/party/party.service';
import { ReactionsService } from '../../../core/services/party/reactions.service';
import { VoiceService } from '../../../core/services/party/voice.service';
import { ControlsVisibilityService } from '../controls/controls-visibility';
import { PartyReactionDockComponent } from './party-reaction-dock';

function setup() {
  const reactions = { bar: () => ['🔥', '😂'] };
  const party = { react: vi.fn() };
  const muted = signal(true);
  const voice = {
    joined: () => true,
    listenOnly: () => false,
    muted,
    setMuted: vi.fn(async (m: boolean) => muted.set(m)),
    toggleMute: vi.fn(async () => muted.set(!muted())),
  };
  const chrome = { holding: signal(false) };
  TestBed.configureTestingModule({
    providers: [
      { provide: ReactionsService, useValue: reactions },
      { provide: PartyService, useValue: party },
      { provide: VoiceService, useValue: voice },
      { provide: ControlsVisibilityService, useValue: chrome },
      provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
    ],
  });
  const fixture = TestBed.createComponent(PartyReactionDockComponent);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  // The player container, listening where the real one does.
  const wake = vi.fn();
  const outer = document.createElement('div');
  for (const t of ['click', 'mousemove']) outer.addEventListener(t, wake);
  outer.append(host);
  document.body.append(outer);
  return { fixture, host, party, wake, voice, chrome };
}

describe('PartyReactionDockComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.animate = (() => ({ finished: Promise.resolve() })) as never;
  });
  afterEach(() => vi.useRealTimers());

  it('keeps click and mousemove from reaching the player', () => {
    const { host, wake } = setup();
    const emoji = host.querySelector<HTMLElement>('.emoji')!;
    for (const t of ['click', 'mousemove']) emoji.dispatchEvent(new Event(t, { bubbles: true }));
    expect(wake).not.toHaveBeenCalled();
  });

  it('sends every tap of a double tap, none reaching the player', () => {
    const { host, party, wake } = setup();
    const emoji = host.querySelector<HTMLElement>('.emoji')!;
    emoji.click();
    emoji.click();
    expect(party.react).toHaveBeenCalledTimes(2);
    expect(wake).not.toHaveBeenCalled();
  });

  const fire = (el: Element, types: string[]) => {
    for (const t of types) el.dispatchEvent(new MouseEvent(t, { bubbles: true, detail: t === 'dblclick' ? 2 : 1 }));
  };

  it('a tap on the mic toggles it, a hold talks only while pressed, a key press toggles', async () => {
    const { fixture, host, voice } = setup();
    const mic = host.querySelector<HTMLElement>('.mic')!;
    fire(mic, ['pointerdown', 'pointerup', 'click']);
    expect(voice.muted()).toBe(false);
    fire(mic, ['pointerdown', 'pointerup', 'click']);
    expect(voice.muted()).toBe(true);

    // Android sends no click after a long press; the next tap must still toggle.
    fire(mic, ['pointerdown']);
    await vi.advanceTimersByTimeAsync(300);
    fixture.detectChanges();
    expect(voice.muted()).toBe(false);
    fire(mic, ['pointerup', 'pointerleave']);
    expect(voice.muted()).toBe(true);
    fire(mic, ['pointerdown', 'pointerup', 'click']);
    expect(voice.muted()).toBe(false);

    mic.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(voice.muted()).toBe(true);
  });

  it('pins the controls while held and releases on a document pointerup after the strip unmounts', async () => {
    const { fixture, host, voice, chrome } = setup();
    const mic = host.querySelector<HTMLElement>('.mic')!;
    fire(mic, ['pointerdown']);
    expect(chrome.holding()).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(voice.muted()).toBe(false);
    mic.remove();
    document.dispatchEvent(new Event('pointerup'));
    expect(voice.muted()).toBe(true);
    expect(chrome.holding()).toBe(false);
    fixture.destroy();
  });

  it('re-mutes a held mic when the dock is destroyed', async () => {
    const { fixture, host, voice, chrome } = setup();
    fire(host.querySelector<HTMLElement>('.mic')!, ['pointerdown']);
    await vi.advanceTimersByTimeAsync(300);
    fixture.destroy();
    expect(voice.muted()).toBe(true);
    expect(chrome.holding()).toBe(false);
  });
});
