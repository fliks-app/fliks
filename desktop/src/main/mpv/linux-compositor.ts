import { app } from 'electron';
import type { LibmpvAddon, LibmpvPlatform } from './libmpv-addon-player';
import type { MpvLoadRequest } from './load-options';

/** The native compositor addon: one SDL window drawing the mpv video under the UI bitmap. */
export type CompositorAddon = LibmpvAddon & {
  start(o: { width: number; height: number; title: string; icon?: string }): void;
  onInput(cb: (json: string) => void): void;
  /** Dirty-rect upload: `rect` holds the pixels of (x, y, w, h) inside a frameW x frameH bitmap. */
  uploadUi(rect: Buffer, frameW: number, frameH: number, x: number, y: number, w: number, h: number): void;
  load(o: MpvLoadRequest): void;
  setFullscreen(enabled: boolean): void;
  /** Whether SDL's window is full screen right now (the state its enter/leave events report). */
  isFullscreen(): boolean;
  /** Asks the window manager to bring the window to the front (best effort on Wayland). */
  raise(): void;
  hide(): void;
  setCursorVisible(visible: boolean): void;
  setCursorShape(shape: number): void;
  /** The decoder and demuxer lists of a throwaway mpv. */
  probeLists(): { 'decoder-list'?: string; 'demuxer-lavf-list'?: string };
};

/** The Linux window model: the compositor window is the app's window and outlives the player,
 *  so ending the session only stops playback. */
export class LinuxCompositor implements LibmpvPlatform {
  /** The window gained or lost focus, or was hidden. */
  onWindowActive?: (active: boolean) => void;
  /** SDL entered or left full screen, whoever asked for it. */
  onFullscreenChange?: (fullscreen: boolean) => void;
  /** The close button was pressed: quit by default. */
  onCloseRequest: () => void = () => app.quit();

  constructor(
    private readonly addon: CompositorAddon,
    private readonly window: { width: number; height: number; title: string; icon?: string },
  ) {}

  start(): void {
    this.addon.start(this.window);
  }

  destroy(): void {
    this.addon.command(['stop']);
  }

  setFullscreen(enabled: boolean): void {
    this.addon.setFullscreen(enabled);
  }

  isFullscreen(): boolean {
    return this.addon.isFullscreen();
  }

  onEvent(raw: { type?: string; active?: boolean }): void {
    switch (raw.type) {
      case 'focus':
        this.onWindowActive?.(raw.active === true);
        break;
      case 'fullscreen':
        this.onFullscreenChange?.(raw.active === true);
        break;
      // The offscreen BrowserWindow never fires window-all-closed: the compositor owns the only visible window.
      case 'closed':
        this.onCloseRequest();
        break;
    }
  }
}
