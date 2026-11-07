import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { ControlsVisibilityService } from '../player/controls/controls-visibility';
import { ReaderProgressService } from './reader-progress.service';
import { ReaderSession } from './reader-session';
import { ReaderSettingsService } from './reader-settings.service';

function setup() {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      ReaderSession,
      ReaderSettingsService,
      { provide: ControlsVisibilityService, useValue: { hide() {}, show() {}, configure() {}, visible: signal(false) } },
      { provide: DismissableStackService, useValue: { push() {}, remove() {} } },
      { provide: ReaderProgressService, useValue: { flush: async () => {} } },
      { provide: AudioPlayerService, useValue: {} },
    ],
  });
  return TestBed.inject(ReaderSession);
}

describe('ReaderSession panels', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('toggles a panel opened twice with openPanel', () => {
    const s = setup();
    s.openPanel('sidebar', 'notes');
    s.openPanel('sidebar', 'notes');
    expect(s.panel()).toBeNull();
  });

  it('keeps the panel open when showPanel targets the tab already open', () => {
    const s = setup();
    s.showPanel('sidebar', 'notes');
    s.showPanel('sidebar', 'notes');
    expect(s.panel()).toBe('sidebar');
    expect(s.tab()).toBe('notes');
  });
});
