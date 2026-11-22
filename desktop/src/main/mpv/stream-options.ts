import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { MPV_STREAM_OPTIONS } from '../../shared/mpv-stream-options';
import { onPinsChanged, pinnedPem } from '../trusted-servers';

let rootsFile: string | null | undefined;

/** The public roots plus every pinned certificate and its chain: mpv trusts no more than Chromium does. FFmpeg rereads it at each handshake. */
function writeRoots(file: string): void {
  const roots = new Set([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system'), ...pinnedPem()]);
  fs.writeFileSync(file, [...roots].join('\n'));
}

/** FFmpeg's TLS reads no OS trust store on Windows, and a bundled OpenSSL may point at a missing one. */
function trustedRootsFile(): string | null {
  if (rootsFile !== undefined) return rootsFile;
  try {
    const file = path.join(app.getPath('userData'), 'tls-roots.pem');
    writeRoots(file);
    onPinsChanged(() => {
      try {
        writeRoots(file);
      } catch (e) {
        console.error('[mpv] trusted roots not rewritten:', e);
      }
    });
    rootsFile = file;
  } catch (e) {
    console.error('[mpv] trusted roots not written:', e);
    rootsFile = null;
  }
  return rootsFile;
}

/** The shared streaming options, plus the trust file every https open verifies against. */
export function mpvStreamOptions(): (readonly [name: string, value: string])[] {
  const roots = trustedRootsFile();
  return roots ? [...MPV_STREAM_OPTIONS, ['tls-ca-file', roots]] : [...MPV_STREAM_OPTIONS];
}
