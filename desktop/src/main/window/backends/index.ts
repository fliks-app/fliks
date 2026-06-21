import type { EmbedBackend } from './types';
import { X11EmbedBackend } from './x11';
import { Win32EmbedBackend } from './win32';

export type { EmbedBackend } from './types';

/**
 * Pick the subprocess-embed backend for the current OS. macOS is NOT handled
 * here: it embeds in-process libmpv (MacMpvPlayer), which `PlayerSession`
 * constructs directly from the video window, so it never routes through an
 * `EmbedBackend` (mpv's subprocess --wid crashes on macOS anyway).
 */
export function createEmbedBackend(): EmbedBackend {
  switch (process.platform) {
    case 'linux':
      return new X11EmbedBackend();
    case 'win32':
      return new Win32EmbedBackend();
    default:
      throw new Error(`no embed backend for platform '${process.platform}' yet`);
  }
}
