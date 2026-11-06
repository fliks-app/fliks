import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { MPV_STREAM_OPTIONS } from '../../shared/mpv-stream-options';

let rootsFile: string | null | undefined;

/** FFmpeg's TLS reads no OS trust store on Windows, and a bundled OpenSSL may point at a missing one. */
function trustedRootsFile(): string | null {
  if (rootsFile !== undefined) return rootsFile;
  try {
    const roots = new Set([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')]);
    rootsFile = path.join(app.getPath('userData'), 'tls-roots.pem');
    fs.writeFileSync(rootsFile, [...roots].join('\n'));
  } catch (e) {
    console.error('[mpv] trusted roots not written:', e);
    rootsFile = null;
  }
  return rootsFile;
}

/** The shared streaming options, plus the roots every https open verifies against. */
export function mpvStreamOptions(): (readonly [name: string, value: string])[] {
  const roots = trustedRootsFile();
  return roots ? [...MPV_STREAM_OPTIONS, ['tls-ca-file', roots]] : [...MPV_STREAM_OPTIONS];
}
