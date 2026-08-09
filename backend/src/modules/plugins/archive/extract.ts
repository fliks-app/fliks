import { createHash, timingSafeEqual } from 'crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as yauzl from 'yauzl';
import type { PluginManifest } from '../../../common/plugin-contract';
import { PluginRefusal, refuse } from './refusal-codes';

export interface ExtractedFile {
  name: string;
  path: string;
  sha256: string;
  size: number;
}

export interface ExtractSuccess {
  ok: true;
  dir: string;
  files: ExtractedFile[];
}

export type ExtractResult = ExtractSuccess | PluginRefusal;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Internal signal that a guard refused mid-extraction — carries the staging dir cleanup with it. */
class ExtractionRefused extends Error {
  constructor(public readonly refusal: PluginRefusal) {
    super(refusal.code);
  }
}

/**
 * V8: fresh `mkdtemp` (mode 0o700 by POSIX definition), each entry written
 * `wx`/0o600 so an existing symlink at the target path is refused rather
 * than followed, then hashed against `manifest.files` for a `process`
 * archive. Independent of {@link inspect} — re-reads the raw bytes rather
 * than trusting anything cached from an earlier call. Any failure purges
 * the staging directory: partial installs are not a state this pipeline has.
 */
export async function extractToStaging(buffer: Buffer, manifest: PluginManifest): Promise<ExtractResult> {
  const zipfile = await yauzl.fromBufferPromise(buffer, {
    lazyEntries: true,
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });

  const dir = mkdtempSync(join(tmpdir(), 'fliks-plugin-'));
  const declaredHashes = manifest.kind === 'process' ? manifest.files : {};
  const files: ExtractedFile[] = [];

  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = entry.fileName;
      const content = await readEntry(zipfile, entry);

      if (name === 'logo.svg' || name === 'logo.png') {
        const badLogo = sniffLogo(name, content);
        if (badLogo) throw new ExtractionRefused(badLogo);
      }

      const actualHash = createHash('sha256').update(content).digest('hex');
      const expectedHash = declaredHashes[name];
      if (expectedHash && !hexEqual(actualHash, expectedHash)) {
        throw new ExtractionRefused(refuse('PLUGIN_HASH_MISMATCH', `${name}: expected ${expectedHash}, got ${actualHash}`));
      }

      const path = join(dir, name);
      writeGuardedFile(path, content);
      files.push({ name, path, sha256: actualHash, size: content.length });
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    if (err instanceof ExtractionRefused) return err.refusal;
    throw err;
  }

  return { ok: true, dir, files };
}

/** `O_EXCL` (`wx`) fails on an existing path — including a pre-planted symlink — rather than following it. */
export function writeGuardedFile(path: string, content: Buffer): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function readEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** PNG by magic bytes; SVG must parse as XML rooted at `<svg>` with no script content. */
export function sniffLogo(name: string, content: Buffer): PluginRefusal | null {
  if (name === 'logo.png') {
    if (!content.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      return refuse('PLUGIN_BAD_LOGO', 'logo.png does not start with the PNG magic bytes');
    }
    return null;
  }
  const text = content.toString('utf8');
  if (!/<svg[\s>]/i.test(text)) {
    return refuse('PLUGIN_BAD_LOGO', 'logo.svg has no <svg> root element');
  }
  if (/<script[\s>]/i.test(text)) {
    return refuse('PLUGIN_BAD_LOGO', 'logo.svg contains a <script> element');
  }
  if (/\son[a-z]+\s*=/i.test(text)) {
    return refuse('PLUGIN_BAD_LOGO', 'logo.svg contains an event-handler attribute');
  }
  if (/javascript:/i.test(text)) {
    return refuse('PLUGIN_BAD_LOGO', 'logo.svg contains a javascript: URI');
  }
  return null;
}

/** Read a subset of named entries out of an already-in-memory archive, ignoring the rest. */
export async function readArchiveEntries(archive: Buffer, wanted: ReadonlySet<string>): Promise<Map<string, Buffer>> {
  const zipfile = await yauzl.fromBufferPromise(archive, {
    lazyEntries: true,
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const found = new Map<string, Buffer>();
  for await (const entry of zipfile.eachEntry()) {
    if (!wanted.has(entry.fileName)) continue;
    found.set(entry.fileName, await readEntry(zipfile, entry));
    if (found.size === wanted.size) break;
  }
  return found;
}

export interface VerifiedLogo {
  contentType: 'image/png' | 'image/svg+xml';
  content: Buffer;
}

/**
 * Serve-time logo read: classifies by magic bytes / XML shape, never by the
 * entry's own name, and re-runs {@link sniffLogo}'s safety checks rather
 * than trusting the install-time pass.
 */
export async function readVerifiedLogo(archive: Buffer): Promise<VerifiedLogo | null> {
  const entries = await readArchiveEntries(archive, new Set(['logo.png', 'logo.svg']));
  const content = entries.get('logo.png') ?? entries.get('logo.svg');
  if (!content) return null;
  if (content.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return sniffLogo('logo.png', content) ? null : { contentType: 'image/png', content };
  }
  return sniffLogo('logo.svg', content) ? null : { contentType: 'image/svg+xml', content };
}
