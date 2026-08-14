/** Turns a built plugin directory into the entries a `.fkplugin` archive carries, applying the same
 *  guards `zip-inspector.ts` and `extract.ts` apply so a bad plugin fails by name, not by refusal code. */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { parseManifest } from './manifest-parser';
import { validateManifestShape } from '../manifest-shape.validator';
import { sniffLogo } from './extract';
import { buildZip } from './zip-builder';
import {
  LEGAL_ENTRY_NAMES,
  MAX_ARCHIVE_COMPRESSED_BYTES,
  MAX_PLUGIN_ID_LENGTH,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  PLUGIN_ID_PATTERN,
  maxUncompressedBytesFor,
} from './limits';
import type { PluginManifest, ProcessPluginManifest } from '../../../common/plugin-contract';

export class PackagingError extends Error {}

function fail(message: string): never {
  throw new PackagingError(message);
}

const CODE_ENTRY_NAME = 'plugin.js';
const LOGO_NAMES = ['logo.svg', 'logo.png'] as const;

interface PackedEntry {
  name: string;
  content: Buffer;
}

export function readPluginDir(dir: string): PackedEntry[] {
  const manifestPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) fail(`no plugin.json in ${dir}`);
  const manifestBytes = fs.readFileSync(manifestPath);

  // Read loosely first: `files` is a required field the tool itself fills in, so the manifest an
  // author writes cannot be validated until the computed hashes are in it.
  let draft: { kind?: unknown; logo?: unknown };
  try {
    draft = JSON.parse(manifestBytes.toString('utf8')) as { kind?: unknown; logo?: unknown };
  } catch {
    fail('plugin.json is not valid JSON');
  }
  const declaredKind = draft.kind;
  const declaredLogo = typeof draft.logo === 'string' ? draft.logo : undefined;

  const hasCode = fs.existsSync(path.join(dir, CODE_ENTRY_NAME));
  if (declaredKind === 'process' && !hasCode) fail(`kind is "process" but ${CODE_ENTRY_NAME} is missing from ${dir}`);
  if (declaredKind === 'data' && hasCode) fail(`kind is "data" but ${CODE_ENTRY_NAME} is present in ${dir} — a data-tier archive may not carry code`);

  const foundLogos = LOGO_NAMES.filter((name) => fs.existsSync(path.join(dir, name)));
  if (foundLogos.length > 1) fail(`only one logo entry is allowed, found both ${foundLogos.join(' and ')}`);
  const logoName = foundLogos[0];
  if (logoName && declaredLogo !== logoName) {
    fail(`manifest.logo declares "${String(declaredLogo)}" but the directory contains "${logoName}"`);
  }
  if (declaredLogo && !logoName) {
    fail(`manifest.logo declares "${declaredLogo}" but no such file exists in ${dir}`);
  }

  // Anything else in the directory would be dropped from the archive without a word, and an
  // author who expected it to ship would find out at runtime.
  const stray = fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) => e.name)
    .filter((name) => !(LEGAL_ENTRY_NAMES as readonly string[]).includes(name));
  if (stray.length) {
    fail(`${dir} holds entries an archive may not carry: ${stray.join(', ')} — legal names are ${LEGAL_ENTRY_NAMES.join(', ')}`);
  }

  const entries: PackedEntry[] = [];
  if (hasCode) entries.push({ name: CODE_ENTRY_NAME, content: fs.readFileSync(path.join(dir, CODE_ENTRY_NAME)) });
  if (logoName) entries.push({ name: logoName, content: fs.readFileSync(path.join(dir, logoName)) });

  for (const { name, content } of entries) {
    const cap = maxUncompressedBytesFor(name);
    if (content.length > cap) fail(`${name} is ${content.length} bytes, cap is ${cap}`);
    // Only the logo: sniffLogo reads any other name as an SVG and would refuse the code file.
    if (name === logoName) {
      const badLogo = sniffLogo(name, content);
      if (badLogo) fail(badLogo.detail);
    }
  }

  // Author-declared hashes are never trusted, only recomputed — a stale or
  // hand-typed `files` map is exactly the mistake this tool exists to remove.
  const withHashes: Record<string, unknown> = { ...(draft as Record<string, unknown>) };
  if (declaredKind === 'process') {
    const files: Record<string, string> = {};
    for (const { name, content } of entries) files[name] = createHash('sha256').update(content).digest('hex');
    withHashes.files = files;
  }
  const finalManifestBytes = Buffer.from(JSON.stringify(withHashes, null, 2), 'utf8');

  const manifest = parseManifest(finalManifestBytes);
  if (!manifest) fail('plugin.json failed structural validation (bad JSON, missing required field, or an unknown key for its kind)');
  const shape = validateManifestShape(manifest);
  if (!shape.ok) fail(`plugin.json: ${shape.detail}`);
  if (manifest.id.length > MAX_PLUGIN_ID_LENGTH || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    fail(`"${manifest.id}" is not a legal plugin id (pattern ${PLUGIN_ID_PATTERN}, max ${MAX_PLUGIN_ID_LENGTH} chars)`);
  }
  if (semver.valid(manifest.version) === null) fail(`"${manifest.version}" is not valid semver`);

  if (finalManifestBytes.length > maxUncompressedBytesFor('plugin.json')) {
    fail(`plugin.json is ${finalManifestBytes.length} bytes, cap is ${maxUncompressedBytesFor('plugin.json')}`);
  }

  const totalUncompressed = finalManifestBytes.length + entries.reduce((sum, e) => sum + e.content.length, 0);
  if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    fail(`archive would declare ${totalUncompressed} uncompressed bytes, cap is ${MAX_TOTAL_UNCOMPRESSED_BYTES}`);
  }

  return [{ name: 'plugin.json', content: finalManifestBytes }, ...entries];
}

/** The finished archive bytes for a built plugin directory. */
export function packPluginDir(dir: string): { archive: Buffer; manifest: PluginManifest } {
  const entries = readPluginDir(dir);
  const archive = buildZip(entries.map((e) => ({ name: e.name, content: e.content })));
  if (archive.length > MAX_ARCHIVE_COMPRESSED_BYTES) {
    fail(`archive is ${archive.length} bytes, cap is ${MAX_ARCHIVE_COMPRESSED_BYTES}`);
  }
  return { archive, manifest: parseManifest(entries[0].content) as PluginManifest };
}
