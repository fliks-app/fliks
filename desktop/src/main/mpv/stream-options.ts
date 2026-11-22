import { app } from 'electron';
import path from 'node:path';
import tls from 'node:tls';
import { MPV_STREAM_OPTIONS } from '../../shared/mpv-stream-options';
import { writeFileAtomic } from '../atomic-file';

let rootsFile: string | null | undefined;

/** FFmpeg's TLS reads no OS trust store on Windows, and a bundled OpenSSL may point at a missing one: it gets the public roots. A pinned server's certificate rides on its own load instead. */
function trustedRootsFile(): string | null {
  if (rootsFile !== undefined) return rootsFile;
  try {
    const file = path.join(app.getPath('userData'), 'tls-roots.pem');
    writeFileAtomic(file, [...new Set([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')])].join('\n'));
    rootsFile = file;
  } catch (e) {
    console.error('[mpv] trusted roots not written:', e);
    rootsFile = null;
  }
  return rootsFile;
}

/** The shared streaming options, plus the public roots file every https open verifies against. */
export function mpvStreamOptions(): (readonly [name: string, value: string])[] {
  const roots = trustedRootsFile();
  return roots ? [...MPV_STREAM_OPTIONS, ['tls-ca-file', roots]] : [...MPV_STREAM_OPTIONS];
}
