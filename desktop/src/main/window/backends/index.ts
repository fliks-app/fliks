import type { EmbedBackend } from './types';
import { X11EmbedBackend } from './x11';
import { Win32EmbedBackend } from './win32';

export type { EmbedBackend } from './types';

/** Pick the embed backend for the current OS. */
export function createEmbedBackend(): EmbedBackend {
  switch (process.platform) {
    case 'linux':
      return new X11EmbedBackend();
    case 'win32':
      return new Win32EmbedBackend();
    case 'darwin':
      // mpv's subprocess --wid CRASHES on macOS (mpv: "--wid works only with
      // libmpv there"). macOS needs an in-process libmpv compositor (a native
      // addon like the Linux one) — not implemented. Callers route macOS to a
      // UI-only window instead of here.
      throw new Error('macOS playback needs an in-process libmpv compositor (not implemented)');
    default:
      throw new Error(`no embed backend for platform '${process.platform}' yet`);
  }
}
