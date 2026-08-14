import { createHash } from 'crypto';
import * as semver from 'semver';
import { validateManifestShape } from '../manifest-shape.validator';
import * as yauzl from 'yauzl';
import type { PluginKind, PluginManifest } from '../../../common/plugin-contract';
import { parseManifest } from './manifest-parser';
import { PluginRefusal, PluginRefusalCode, refuse } from './refusal-codes';
import { resolveTrust, OFFICIAL_KEYS, TrustOutcome } from './trust-store';
import {
  ED25519_SIGNATURE_LENGTH,
  LEGAL_ENTRY_NAMES,
  MAX_ARCHIVE_COMPRESSED_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ENTRY_RATIO,
  MAX_PLUGIN_ID_LENGTH,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  PLUGIN_ID_PATTERN,
  PROCESS_ONLY_ENTRY_NAMES,
  maxUncompressedBytesFor,
} from './limits';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const DATA_DESCRIPTOR_BIT = 0x0008;
const DIRECTORY_ATTRIBUTE_BIT = 0x10;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;
const MAX_CONTROL_CODE = 0x1f;
const DEL_CODE = 0x7f;
const ABSOLUTE_PATH_PATTERN = /^\/|^[A-Za-z]:/;

/** NUL and other control characters — yauzl does not check for these. */
function hasControlChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= MAX_CONTROL_CODE || code === DEL_CODE) return true;
  }
  return false;
}

export interface InspectOptions {
  /** Test-only override of the compiled-in official key set. Defaults to {@link OFFICIAL_KEYS}. */
  officialKeys?: ReadonlyMap<string, Buffer>;
  /** Admin-registered third-party keys (empty until Phase 7's key registry ships). */
  thirdPartyKeys?: ReadonlyMap<string, Buffer>;
  /** `FLIKS_UNSIGNED_PLUGINS` ids — the only way a `process` plugin may ship unsigned. */
  unsignedProcessAllowlist?: readonly string[];
}

export interface InspectSuccess {
  ok: true;
  id: string;
  version: string;
  kind: PluginKind;
  manifest: PluginManifest;
  sha256: string;
  signature: TrustOutcome;
  signedByKeyId?: string;
  capabilities: string[];
  entryNames: string[];
}

export type InspectResult = InspectSuccess | PluginRefusal;

interface WalkedEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

/**
 * V1-V7 of the install pipeline. Nothing touches disk. The signature is
 * verified before the manifest's business rules are even read — this
 * function's refusal order is deliberate, not convenience.
 */
export async function inspect(buffer: Buffer, options: InspectOptions = {}): Promise<InspectResult> {
  // V1/V2 - bytes already in RAM; magic + whole-archive size cap, nothing parsed yet.
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    return refuse('PLUGIN_BAD_MAGIC', 'archive does not start with the ZIP local-file-header signature');
  }
  if (buffer.length > MAX_ARCHIVE_COMPRESSED_BYTES) {
    return refuse('PLUGIN_TOO_LARGE', `archive is ${buffer.length} bytes, cap is ${MAX_ARCHIVE_COMPRESSED_BYTES}`);
  }
  const ambiguity = checkEocdAmbiguity(buffer);
  if (ambiguity) return ambiguity;
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  // V3 - open via the central directory; entry count comes from the EOCD before any entry is read.
  let zipfile: yauzl.ZipFile;
  try {
    zipfile = await yauzl.fromBufferPromise(buffer, {
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
  } catch (err) {
    return refuse(classifyYauzlError(err) ?? 'PLUGIN_MALFORMED_ARCHIVE', String(err));
  }
  if (zipfile.comment.length > 0) {
    return refuse('PLUGIN_ARCHIVE_COMMENT', 'archive carries a nonzero comment');
  }
  if (zipfile.entryCount > MAX_ARCHIVE_ENTRIES) {
    return refuse('PLUGIN_TOO_MANY_ENTRIES', `${zipfile.entryCount} entries, cap is ${MAX_ARCHIVE_ENTRIES}`);
  }

  // V4 - walk the central directory. One failure refuses the whole archive.
  const seenExact = new Set<string>();
  const seenLower = new Set<string>();
  let sawLogo = false;
  let totalUncompressed = 0;
  const walked: WalkedEntry[] = [];
  const entryBuffers = new Map<string, () => Promise<Buffer>>();

  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = entry.fileName;

      if (hasControlChar(name)) {
        return refuse('PLUGIN_CONTROL_CHAR', `control character in entry name ${JSON.stringify(name)}`);
      }
      if (name !== name.normalize('NFC')) {
        return refuse('PLUGIN_NOT_NFC', `entry name ${JSON.stringify(name)} is not NFC-normalised`);
      }
      if (name.includes('/')) {
        return refuse('PLUGIN_PATH_SEPARATOR', `entry name ${JSON.stringify(name)} contains a path separator`);
      }
      if (ABSOLUTE_PATH_PATTERN.test(name)) {
        return refuse('PLUGIN_ABSOLUTE_PATH', `entry name ${JSON.stringify(name)} is an absolute path`);
      }
      if ((entry.externalFileAttributes & DIRECTORY_ATTRIBUTE_BIT) !== 0) {
        return refuse('PLUGIN_DIRECTORY_ENTRY', `entry ${JSON.stringify(name)} is flagged as a directory`);
      }
      // Judge the type only when the writer declared one: python's zipfile and
      // every DOS-era tool emit permission bits with an empty type nibble, and
      // reading that as "not a regular file" refuses well-formed archives.
      const fileType =
        (entry.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
      if (fileType !== 0 && fileType !== UNIX_REGULAR_FILE) {
        return refuse('PLUGIN_SYMLINK', `entry ${JSON.stringify(name)} is not a regular file (type 0${fileType.toString(8)})`);
      }
      if (seenExact.has(name) || seenLower.has(name.toLowerCase())) {
        return refuse('PLUGIN_DUPLICATE_ENTRY', `duplicate entry ${JSON.stringify(name)}`);
      }
      seenExact.add(name);
      seenLower.add(name.toLowerCase());

      if (!(LEGAL_ENTRY_NAMES as readonly string[]).includes(name)) {
        return refuse('PLUGIN_UNEXPECTED_ENTRY', `${JSON.stringify(name)} is not one of the legal entry names`);
      }
      if (name === 'logo.svg' || name === 'logo.png') {
        if (sawLogo) return refuse('PLUGIN_DUPLICATE_ENTRY', 'archive carries more than one logo entry');
        sawLogo = true;
      }
      if (entry.extraFields.some((f) => f.id === ZIP64_EXTRA_FIELD_ID)) {
        return refuse('PLUGIN_ZIP64', `entry ${JSON.stringify(name)} carries a ZIP64 extra field`);
      }
      if ((entry.generalPurposeBitFlag & DATA_DESCRIPTOR_BIT) !== 0) {
        return refuse('PLUGIN_DATA_DESCRIPTOR', `entry ${JSON.stringify(name)} uses a data descriptor`);
      }
      if (entry.isEncrypted()) {
        return refuse('PLUGIN_ENCRYPTED', `entry ${JSON.stringify(name)} is encrypted`);
      }
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        return refuse('PLUGIN_COMPRESSION_METHOD', `entry ${JSON.stringify(name)} uses compression method ${entry.compressionMethod}`);
      }
      const cap = maxUncompressedBytesFor(name);
      if (entry.uncompressedSize > cap) {
        const code: PluginRefusalCode = name === 'plugin.json' ? 'PLUGIN_MANIFEST_TOO_LARGE' : 'PLUGIN_TOO_LARGE';
        return refuse(code, `entry ${JSON.stringify(name)} declares ${entry.uncompressedSize} bytes, cap is ${cap}`);
      }
      if (entry.compressedSize > 0) {
        const ratio = entry.uncompressedSize / entry.compressedSize;
        if (ratio > MAX_ENTRY_RATIO) {
          return refuse('PLUGIN_RATIO', `entry ${JSON.stringify(name)} has a ${ratio.toFixed(1)}:1 compression ratio`);
        }
      } else if (entry.uncompressedSize > 0) {
        return refuse('PLUGIN_RATIO', `entry ${JSON.stringify(name)} declares content from zero compressed bytes`);
      }

      totalUncompressed += entry.uncompressedSize;
      walked.push({ name, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize });
      entryBuffers.set(name, () => readEntry(zipfile, entry));
    }
  } catch (err) {
    // Refuse rather than throw: an unclassified malformation is still the
    // archive's fault, and the caller's contract is a code.
    return refuse(classifyYauzlError(err) ?? 'PLUGIN_MALFORMED_ARCHIVE', String(err));
  }

  if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    return refuse('PLUGIN_TOO_LARGE', `archive declares ${totalUncompressed} uncompressed bytes, cap is ${MAX_TOTAL_UNCOMPRESSED_BYTES}`);
  }

  // V5 - inflate plugin.json (+ its signature) into memory. Nothing else is read yet.
  const manifestReader = entryBuffers.get('plugin.json');
  if (!manifestReader) {
    return refuse('PLUGIN_BAD_MANIFEST', 'archive has no plugin.json entry');
  }
  let manifestBytes: Buffer;
  let sigBytes: Buffer | null = null;
  try {
    manifestBytes = await manifestReader();
    const sigReader = entryBuffers.get('plugin.json.sig');
    if (sigReader) {
      const sigText = (await sigReader()).toString('utf8').trim();
      sigBytes = Buffer.from(sigText, 'base64');
    }
  } catch (err) {
    // A lying central-directory entry surfaces here as a stream error - the
    // one guard `validateEntrySizes` implements that we cannot from outside.
    return refuse('PLUGIN_TOO_LARGE', `entry content did not match its declared size: ${String(err)}`);
  }

  // V6 - verify Ed25519 before a single business rule from the manifest is trusted.
  if (sigBytes && sigBytes.length !== ED25519_SIGNATURE_LENGTH) {
    return refuse('PLUGIN_BAD_SIGNATURE', `signature is ${sigBytes.length} bytes, expected ${ED25519_SIGNATURE_LENGTH}`);
  }
  const officialKeys = options.officialKeys ?? OFFICIAL_KEYS;
  const trust = resolveTrust(manifestBytes, sigBytes, officialKeys, options.thirdPartyKeys ?? new Map());

  // V7 - only now is the manifest content itself read.
  const manifest = parseManifest(manifestBytes);
  if (!manifest) {
    return refuse('PLUGIN_BAD_MANIFEST', 'plugin.json failed structural validation');
  }
  if (manifest.id.length > MAX_PLUGIN_ID_LENGTH || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    return refuse('PLUGIN_BAD_ID', `id ${JSON.stringify(manifest.id)} is not a legal plugin id`);
  }
  if (semver.valid(manifest.version) === null) {
    return refuse('PLUGIN_BAD_VERSION', `version ${JSON.stringify(manifest.version)} is not valid semver`);
  }
  // Ahead of `deriveCapabilities`, which walks `ui` and would either throw or invent entries.
  const shape = validateManifestShape(manifest);
  if (!shape.ok) return shape;
  const hasPluginJs = entryBuffers.has('plugin.js');
  if (manifest.kind === 'data' && hasPluginJs) {
    return refuse('PLUGIN_TIER_VIOLATION', 'a data-tier archive may not carry plugin.js');
  }
  if (manifest.kind === 'process' && !hasPluginJs) {
    return refuse('PLUGIN_TIER_VIOLATION', 'a process-tier archive must carry plugin.js');
  }
  if (manifest.kind === 'process') {
    if (trust.trust === 'unsigned' && !(options.unsignedProcessAllowlist ?? []).includes(manifest.id)) {
      return refuse('PLUGIN_UNSIGNED', 'process-tier plugins must be signed unless allowlisted');
    }
    const codeNames = new Set(
      walked.map((w) => w.name).filter((n) => PROCESS_ONLY_ENTRY_NAMES.has(n) || n.startsWith('logo.')),
    );
    const declared = new Set(Object.keys(manifest.files));
    const mismatch = [...codeNames].some((n) => !declared.has(n)) || [...declared].some((n) => !codeNames.has(n));
    if (mismatch) {
      return refuse('PLUGIN_FILE_SET_MISMATCH', 'archive entries and manifest.files disagree');
    }
  }

  return {
    ok: true,
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    manifest,
    sha256,
    signature: trust.trust,
    signedByKeyId: trust.signedByKeyId,
    capabilities: deriveCapabilities(manifest),
    entryNames: walked.map((w) => w.name),
  };
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

/**
 * Two central directories / trailing data: the raw signature bytes must
 * occur exactly once in the buffer. A second occurrence - an appended
 * archive, or a decoy planted earlier - means a different tool reading
 * the same bytes (a registry reviewer's `unzip -l`) can disagree with
 * what this code is about to parse.
 */
function checkEocdAmbiguity(buffer: Buffer): PluginRefusal | null {
  const first = buffer.indexOf(EOCD_SIGNATURE);
  const last = buffer.lastIndexOf(EOCD_SIGNATURE);
  if (first !== -1 && first !== last) {
    return refuse('PLUGIN_TRAILING_DATA', 'archive contains more than one end-of-central-directory signature');
  }
  return null;
}

/** Map yauzl's own thrown/emitted errors - generic `Error` objects - onto our typed codes. */
function classifyYauzlError(err: unknown): PluginRefusalCode | null {
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid characters in fileName/.test(message)) return 'PLUGIN_PATH_SEPARATOR';
  if (/absolute path/.test(message)) return 'PLUGIN_ABSOLUTE_PATH';
  if (/invalid relative path/.test(message)) return 'PLUGIN_PATH_SEPARATOR';
  if (/strong encryption/.test(message)) return 'PLUGIN_ENCRYPTED';
  if (/Invalid comment length/.test(message)) return 'PLUGIN_TRAILING_DATA';
  if (/compressed\/uncompressed size mismatch/.test(message)) return 'PLUGIN_TOO_LARGE';
  if (/unsupported compression method/.test(message)) return 'PLUGIN_COMPRESSION_METHOD';
  return null;
}

/** Lightweight capability summary for the (future) consent sheet - not the sheet itself. */
function deriveCapabilities(manifest: PluginManifest): string[] {
  const caps: string[] = [];
  for (const c of manifest.ui?.contributions ?? []) caps.push(`ui:${c.slot}`);
  for (const p of manifest.ui?.configPages ?? []) caps.push(`config:${p.id}`);
  if (manifest.events?.length) caps.push('webhook');
  if (manifest.kind === 'process') {
    for (const s of manifest.scopes) caps.push(`scope:${s}`);
    for (const r of manifest.ingestRoots) caps.push(`ingestroot:${r}`);
    for (const j of manifest.jobs ?? []) caps.push(`job:${j.name}`);
  }
  return caps;
}
