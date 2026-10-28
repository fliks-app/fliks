import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceService } from '../../core/services/device.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { CastOverlayComponent } from './cast-overlay';

function setup(over: { local?: boolean; tv?: boolean; fileId?: number } = {}) {
  const output = {
    fanartUrl: signal<string | null>(null),
    mediaTitle: signal('Title'),
    isIdle: signal(false),
    targetOffline: signal(false),
    uiPaused: signal(false),
    disconnect: vi.fn(),
  };
  const session = {
    isLocal: signal(over.local ?? false),
    output: signal(output),
    deviceName: signal('Living room'),
    playing: signal(over.fileId === 0 ? null : { fileId: 7, mediaId: 3 }),
    openPlayer: vi.fn(),
    command: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideTranslateService(),
      provideZonelessChangeDetection(),
      { provide: PlaybackSession, useValue: session },
      { provide: DeviceService, useValue: { isTv: () => !!over.tv } },
    ],
  });
  const fixture = TestBed.createComponent(CastOverlayComponent);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, session, output };
}

describe('CastOverlayComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the device and title while playing elsewhere', () => {
    const { el } = setup();
    expect(el.textContent).toContain('Title');
    expect(el.textContent).toContain('Living room');
  });

  it('is absent while playing locally and on a TV', () => {
    expect(setup({ local: true }).el.querySelector('button')).toBeNull();
    TestBed.resetTestingModule();
    expect(setup({ tv: true }).el.querySelector('button')).toBeNull();
  });

  it('opens the player on a tap, pauses and disconnects from its own buttons', () => {
    const { el, session, output } = setup();
    const [open, play, close] = Array.from(el.querySelectorAll('button'));
    open.click();
    play.click();
    close.click();
    expect(session.openPlayer).toHaveBeenCalled();
    expect(session.command).toHaveBeenCalledWith({ type: 'toggle' });
    expect(output.disconnect).toHaveBeenCalled();
  });

  it('cannot open the player while nothing plays', () => {
    const { el } = setup({ fileId: 0 });
    expect(el.querySelector('button')!.disabled).toBe(true);
  });
});
