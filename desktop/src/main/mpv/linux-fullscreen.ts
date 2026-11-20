import type { DesktopEvent } from '../../shared/contract';

type FullscreenSource = {
  onFullscreenChange?: (fullscreen: boolean) => void;
  setFullscreen(enabled: boolean): void;
  isFullscreen(): boolean;
};

/** Full screen on Linux is whatever SDL reports: a request changes nothing here until the window
 *  does, and a change the window manager makes by itself is reported the same way. */
export function linuxFullscreen(source: FullscreenSource, send: (ev: DesktopEvent) => void) {
  source.onFullscreenChange = (fullscreen) => send({ type: 'fullscreenChanged', payload: { fullscreen } });
  return { set: (enabled: boolean) => source.setFullscreen(enabled), get: () => source.isFullscreen() };
}
