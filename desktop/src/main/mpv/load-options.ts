import type { DesktopLoadOptions } from '../../shared/contract';
import { mpvVerifies } from '../trusted-servers.ts';

/** The payload the libmpv addons receive: the renderer's options plus the
 *  per-file mpv options built by {@link mpvLoadFileOptions}. */
export type MpvLoadRequest = DesktopLoadOptions & { fileOptions: string[] };

/** File-local mpv options (`name=value`) every backend passes on `loadfile`.
 *  `sid=no` makes the load itself carry the subtitle intent — the app picks the
 *  track, so mpv must never auto-select one while the new file opens. */
export function mpvLoadFileOptions(opts: DesktopLoadOptions): string[] {
  const fileOptions = ['sid=no'];
  if (opts.startTime && opts.startTime > 0) fileOptions.push(`start=+${opts.startTime.toFixed(3)}`);
  // Keeps the matching audio rendition across reconfigs instead of the manifest default. The value joins a
  // comma-separated option list, so only a language code goes through.
  const alang = opts.audioLanguage?.toLowerCase();
  if (alang && /^[a-z]{2,3}$/.test(alang)) fileOptions.push(`alang=${alang}`);
  if (!mpvVerifies(opts.url)) fileOptions.push('tls-verify=no');
  return fileOptions;
}

export function mpvLoadRequest(opts: DesktopLoadOptions): MpvLoadRequest {
  return { ...opts, fileOptions: mpvLoadFileOptions(opts) };
}
