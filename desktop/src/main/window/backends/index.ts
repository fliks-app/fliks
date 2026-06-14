import type { EmbedBackend } from './types';
import { X11EmbedBackend } from './x11';

export type { EmbedBackend } from './types';

/** Pick the embed backend for the current OS. */
export function createEmbedBackend(): EmbedBackend {
  switch (process.platform) {
    case 'linux':
      return new X11EmbedBackend();
    // 'darwin' (child NSView) and 'win32' (child HWND) backends land with the
    // macOS/Windows milestones.
    default:
      throw new Error(`no embed backend for platform '${process.platform}' yet`);
  }
}
