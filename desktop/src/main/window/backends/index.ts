import type { EmbedBackend } from './types';
import { Win32EmbedBackend } from './win32';

export type { EmbedBackend } from './types';

/**
 * Windows-only: the subprocess mpv (`--wid`) embed backend. macOS embeds
 * in-process libmpv directly (`MacMpvPlayer`, never via this interface); Linux
 * uses its own native compositor addon and never reaches `PlayerSession`.
 */
export function createEmbedBackend(): EmbedBackend {
  if (process.platform === 'win32') return new Win32EmbedBackend();
  throw new Error(`no embed backend for platform '${process.platform}'`);
}
