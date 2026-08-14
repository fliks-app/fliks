import { deflateRawSync } from 'zlib';
import { inspect } from './zip-inspector';
import { buildZip, ZipEntrySpec } from './zip-builder';
import { generateTestKeypair, signManifestBase64 } from './ed25519-test-keys';
import { minimalDataManifest, minimalProcessManifest } from './test-manifests';
import { pngLogo, sha256Hex, svgLogo } from './test-fixtures';
import { PluginRefusalCode } from './refusal-codes';
import type { ProcessPluginManifest } from '../../../common/plugin-contract';

/** Sign a manifest object and return its raw bytes + a `plugin.json.sig` entry spec. */
function signedManifestEntries(manifest: unknown): { manifestBytes: Buffer; entries: ZipEntrySpec[] } {
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const { privateKey } = generateTestKeypair();
  const sig = signManifestBase64(privateKey, manifestBytes);
  return {
    manifestBytes,
    entries: [
      { name: 'plugin.json', content: manifestBytes },
      { name: 'plugin.json.sig', content: Buffer.from(sig, 'utf8') },
    ],
  };
}

async function expectRefusal(buffer: Buffer, code: PluginRefusalCode) {
  const result = await inspect(buffer);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

describe('inspect() — happy path', () => {
  it('accepts a well-formed signed data archive', async () => {
    const manifest = minimalDataManifest();
    const { entries } = signedManifestEntries(manifest);
    const buffer = buildZip([...entries, { name: 'logo.svg', content: svgLogo() }]);

    const result = await inspect(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('data');
    expect(result.id).toBe(manifest.id);
    expect(result.signature).toBe('unverified'); // signer is not in any trust store
    expect(result.entryNames.sort()).toEqual(['logo.svg', 'plugin.json', 'plugin.json.sig']);
  });

  it('resolves to `official` when the signer is a compiled-in official key', async () => {
    const manifest = minimalDataManifest();
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const sig = signManifestBase64(privateKey, manifestBytes);
    const officialKeys = new Map([['release-2026', rawPublicKey]]);
    const buffer = buildZip([
      { name: 'plugin.json', content: manifestBytes },
      { name: 'plugin.json.sig', content: Buffer.from(sig, 'utf8') },
      { name: 'logo.svg', content: svgLogo() },
    ]);

    const result = await inspect(buffer, { officialKeys });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signature).toBe('official');
    expect(result.signedByKeyId).toBe('release-2026');
  });

  it('accepts a well-formed signed process archive and reports its capabilities', async () => {
    const pluginJs = Buffer.from('module.exports = {};', 'utf8');
    const logo = pngLogo();
    const files = { 'plugin.js': sha256Hex(pluginJs), 'logo.png': sha256Hex(logo) };
    const manifest = minimalProcessManifest(files, {
      jobs: [{ name: 'sync', cron: '0 * * * *', triggerable: true, labelKey: 'jobs.sync' }],
      ingestRoots: ['/media/downloads'],
    });
    const { entries } = signedManifestEntries(manifest);
    const buffer = buildZip([
      ...entries,
      { name: 'plugin.js', content: pluginJs },
      { name: 'logo.png', content: logo },
    ]);

    const result = await inspect(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('process');
    expect(result.capabilities).toContain('scope:media:read');
    expect(result.capabilities).toContain('job:sync');
    expect(result.capabilities).toContain('ingestroot:/media/downloads');
  });
});

describe('inspect() — guards', () => {
  it('PLUGIN_BAD_MAGIC: prepended data / not a zip at all', async () => {
    await expectRefusal(Buffer.from('not a zip file at all'), 'PLUGIN_BAD_MAGIC');
  });

  it('PLUGIN_TOO_LARGE: whole archive over the 8 MiB compressed cap', async () => {
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
    buffer.set([0x50, 0x4b, 0x03, 0x04], 0);
    await expectRefusal(buffer, 'PLUGIN_TOO_LARGE');
  });

  it('PLUGIN_TRAILING_DATA: garbage appended after the EOCD record', async () => {
    const { entries } = signedManifestEntries(minimalDataManifest());
    const buffer = buildZip([...entries, { name: 'logo.svg', content: svgLogo() }], {
      trailingBytes: Buffer.from('x'),
    });
    await expectRefusal(buffer, 'PLUGIN_TRAILING_DATA');
  });

  it('PLUGIN_TRAILING_DATA: two central directories (a second archive concatenated on)', async () => {
    const { entries } = signedManifestEntries(minimalDataManifest());
    const one = buildZip([...entries, { name: 'logo.svg', content: svgLogo() }]);
    const buffer = Buffer.concat([one, one]);
    await expectRefusal(buffer, 'PLUGIN_TRAILING_DATA');
  });

  it('PLUGIN_ARCHIVE_COMMENT: nonzero archive comment', async () => {
    const { entries } = signedManifestEntries(minimalDataManifest());
    const buffer = buildZip([...entries, { name: 'logo.svg', content: svgLogo() }], {
      archiveComment: 'hello',
    });
    await expectRefusal(buffer, 'PLUGIN_ARCHIVE_COMMENT');
  });

  it('PLUGIN_TOO_MANY_ENTRIES: more than 4 entries, read from the EOCD', async () => {
    const buffer = buildZip(
      ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: n, content: Buffer.from(n) })),
    );
    await expectRefusal(buffer, 'PLUGIN_TOO_MANY_ENTRIES');
  });

  it('PLUGIN_CONTROL_CHAR: NUL byte in an entry name', async () => {
    const name = 'logo.svg' + String.fromCharCode(0) + '.js';
    const buffer = buildZip([{ name, content: svgLogo() }]);
    await expectRefusal(buffer, 'PLUGIN_CONTROL_CHAR');
  });

  it('PLUGIN_NOT_NFC: a decomposed-form entry name', async () => {
    const name = 'logo' + '́' + '.svg'; // combining acute accent, never precomposed
    const buffer = buildZip([{ name, content: svgLogo() }]);
    await expectRefusal(buffer, 'PLUGIN_NOT_NFC');
  });

  it('PLUGIN_PATH_SEPARATOR: a nested path yauzl itself accepts as legal', async () => {
    const buffer = buildZip([{ name: 'sub/plugin.json', content: Buffer.from('{}') }]);
    await expectRefusal(buffer, 'PLUGIN_PATH_SEPARATOR');
  });

  it('PLUGIN_PATH_SEPARATOR: a backslash separator (strictFileNames makes yauzl error)', async () => {
    const buffer = buildZip([{ name: 'sub\\plugin.json', content: Buffer.from('{}') }]);
    await expectRefusal(buffer, 'PLUGIN_PATH_SEPARATOR');
  });

  it('PLUGIN_ABSOLUTE_PATH: a rooted path', async () => {
    const buffer = buildZip([{ name: '/etc/passwd', content: Buffer.from('x') }]);
    await expectRefusal(buffer, 'PLUGIN_ABSOLUTE_PATH');
  });

  it('PLUGIN_ABSOLUTE_PATH: a drive-letter path', async () => {
    const buffer = buildZip([{ name: 'C:evil.txt', content: Buffer.from('x') }]);
    await expectRefusal(buffer, 'PLUGIN_ABSOLUTE_PATH');
  });

  it('PLUGIN_DUPLICATE_ENTRY: the exact same name twice in the central directory', async () => {
    const buffer = buildZip([{ name: 'plugin.json', content: Buffer.from('{}') }], {
      duplicateCentralDirectoryRecords: [0],
    });
    await expectRefusal(buffer, 'PLUGIN_DUPLICATE_ENTRY');
  });

  it('PLUGIN_DUPLICATE_ENTRY: two names differing only by case', async () => {
    const buffer = buildZip([
      { name: 'logo.svg', content: svgLogo() },
      { name: 'Logo.svg', content: svgLogo() },
    ]);
    await expectRefusal(buffer, 'PLUGIN_DUPLICATE_ENTRY');
  });

  it('PLUGIN_DUPLICATE_ENTRY: a second logo slot (svg + png together)', async () => {
    const buffer = buildZip([
      { name: 'logo.svg', content: svgLogo() },
      { name: 'logo.png', content: pngLogo() },
    ]);
    await expectRefusal(buffer, 'PLUGIN_DUPLICATE_ENTRY');
  });

  it('PLUGIN_DIRECTORY_ENTRY: the DOS directory attribute bit on a plain-named entry', async () => {
    const buffer = buildZip([
      { name: 'logo.svg', content: svgLogo(), externalFileAttributes: 0x10 },
    ]);
    await expectRefusal(buffer, 'PLUGIN_DIRECTORY_ENTRY');
  });

  it('accepts permission bits with no file-type nibble, as python zipfile writes', async () => {
    // 0o600 << 16 and nothing else: an empty type nibble is not the same as a
    // type declared to be something other than a regular file. Caught against
    // an archive written by python's zipfile, which every entry looks like.
    const permsOnly = (0o600 << 16) >>> 0;
    const { entries } = signedManifestEntries(minimalDataManifest());
    const buffer = buildZip(
      [...entries, { name: 'logo.svg', content: svgLogo() }].map((e) => ({
        ...e,
        externalFileAttributes: permsOnly,
      })),
    );

    const result = await inspect(buffer);
    expect(result.ok).toBe(true);
  });

  it('PLUGIN_SYMLINK: a Unix symlink mode in externalFileAttributes', async () => {
    const symlinkMode = 0xa1ff; // S_IFLNK | 0777
    const buffer = buildZip([
      { name: 'logo.png', content: pngLogo(), externalFileAttributes: (symlinkMode << 16) >>> 0 },
    ]);
    await expectRefusal(buffer, 'PLUGIN_SYMLINK');
  });

  it('PLUGIN_UNEXPECTED_ENTRY: a name outside the closed literal set', async () => {
    const buffer = buildZip([{ name: 'README.md', content: Buffer.from('hi') }]);
    await expectRefusal(buffer, 'PLUGIN_UNEXPECTED_ENTRY');
  });

  it('PLUGIN_ZIP64: a ZIP64 extended-information extra field', async () => {
    const buffer = buildZip([
      { name: 'logo.svg', content: svgLogo(), extraFields: [{ id: 0x0001, data: Buffer.alloc(0) }] },
    ]);
    await expectRefusal(buffer, 'PLUGIN_ZIP64');
  });

  it('PLUGIN_DATA_DESCRIPTOR: general-purpose bit 3 set', async () => {
    const buffer = buildZip([
      { name: 'logo.svg', content: svgLogo(), generalPurposeBitFlag: 0x0800 | 0x0008 },
    ]);
    await expectRefusal(buffer, 'PLUGIN_DATA_DESCRIPTOR');
  });

  it('PLUGIN_ENCRYPTED: general-purpose bit 0 set', async () => {
    // compressionMethod: 8 sidesteps yauzl's own store-mode size-consistency
    // check (which the encryption bit would otherwise fail before we get a look).
    const buffer = buildZip([
      {
        name: 'logo.svg',
        content: svgLogo(),
        compressionMethod: 8,
        generalPurposeBitFlag: 0x0800 | 0x0001,
      },
    ]);
    await expectRefusal(buffer, 'PLUGIN_ENCRYPTED');
  });

  it('PLUGIN_COMPRESSION_METHOD: a method other than store or deflate', async () => {
    const buffer = buildZip([{ name: 'logo.svg', content: svgLogo(), compressionMethod: 99 }]);
    await expectRefusal(buffer, 'PLUGIN_COMPRESSION_METHOD');
  });

  it('PLUGIN_MANIFEST_TOO_LARGE: plugin.json over the 256 KiB cap', async () => {
    const content = Buffer.alloc(300 * 1024, 0x7b);
    const buffer = buildZip([{ name: 'plugin.json', content, compressionMethod: 8 }]);
    await expectRefusal(buffer, 'PLUGIN_MANIFEST_TOO_LARGE');
  });

  it('PLUGIN_TOO_LARGE: logo over its 64 KiB cap', async () => {
    const content = Buffer.alloc(70 * 1024, 0x41);
    const buffer = buildZip([{ name: 'logo.png', content, compressionMethod: 8 }]);
    await expectRefusal(buffer, 'PLUGIN_TOO_LARGE');
  });

  it('PLUGIN_RATIO: a highly-compressible entry over the 100:1 cap', async () => {
    const content = Buffer.alloc(20000, 0);
    const buffer = buildZip([{ name: 'logo.svg', content, compressionMethod: 8 }]);
    await expectRefusal(buffer, 'PLUGIN_RATIO');
  });

  it('PLUGIN_TOO_LARGE: a lying central directory understates plugin.json size (validateEntrySizes)', async () => {
    const realContent = Buffer.alloc(5000, 0x41);
    const buffer = buildZip([
      {
        name: 'plugin.json',
        content: realContent,
        compressionMethod: 8,
        declaredUncompressedSize: 100, // the lie: real inflate produces 5000 bytes
      },
    ]);
    await expectRefusal(buffer, 'PLUGIN_TOO_LARGE');
  });

  it('PLUGIN_BAD_MANIFEST: plugin.json is not valid JSON', async () => {
    const buffer = buildZip([{ name: 'plugin.json', content: Buffer.from('{not json') }]);
    await expectRefusal(buffer, 'PLUGIN_BAD_MANIFEST');
  });

  it('PLUGIN_BAD_MANIFEST: missing a required field', async () => {
    const manifest = minimalDataManifest();
    delete (manifest as unknown as Record<string, unknown>).name;
    const buffer = buildZip([{ name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) }]);
    await expectRefusal(buffer, 'PLUGIN_BAD_MANIFEST');
  });

  it('PLUGIN_BAD_MANIFEST: an unknown top-level key', async () => {
    const manifest = { ...minimalDataManifest(), evil: true };
    const buffer = buildZip([{ name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) }]);
    await expectRefusal(buffer, 'PLUGIN_BAD_MANIFEST');
  });

  it('PLUGIN_BAD_MANIFEST: a scope retired from the vocabulary (blocklist:write, once core owned the table) is refused, not silently accepted', async () => {
    // Cast past the type system on purpose — a real attacker's manifest.json
    // isn't type-checked either, and the runtime validator must refuse it too.
    const scopes = [
      'blocklist:write',
    ] as unknown as ProcessPluginManifest['scopes'];
    const manifest = minimalProcessManifest({}, { scopes });
    const buffer = buildZip([
      { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) },
    ]);
    await expectRefusal(buffer, 'PLUGIN_BAD_MANIFEST');
  });

  it('PLUGIN_BAD_SIGNATURE: a signature that does not decode to 64 bytes', async () => {
    const manifestBytes = Buffer.from(JSON.stringify(minimalDataManifest()), 'utf8');
    const buffer = buildZip([
      { name: 'plugin.json', content: manifestBytes },
      { name: 'plugin.json.sig', content: Buffer.from(Buffer.from('too short').toString('base64')) },
    ]);
    await expectRefusal(buffer, 'PLUGIN_BAD_SIGNATURE');
  });

  it('PLUGIN_BAD_ID: an id the published catalog schema would also refuse', async () => {
    const manifest = minimalDataManifest({ id: 'fliks.Test-Plugin' });
    const buffer = buildZip([{ name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) }]);
    await expectRefusal(buffer, 'PLUGIN_BAD_ID');
  });

  it('PLUGIN_BAD_ID: an id past the 56-char cap', async () => {
    const manifest = minimalDataManifest({ id: `fliks.${'a'.repeat(56)}` });
    const buffer = buildZip([{ name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) }]);
    await expectRefusal(buffer, 'PLUGIN_BAD_ID');
  });

  it('PLUGIN_BAD_VERSION: a version that is not valid semver', async () => {
    const manifest = minimalDataManifest({ version: 'not-a-version' });
    const buffer = buildZip([{ name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) }]);
    await expectRefusal(buffer, 'PLUGIN_BAD_VERSION');
  });

  it('PLUGIN_UNSIGNED: a process-tier archive with no plugin.json.sig entry', async () => {
    const pluginJs = Buffer.from('module.exports = {};');
    const logo = pngLogo();
    const manifest = minimalProcessManifest({ 'plugin.js': sha256Hex(pluginJs), 'logo.png': sha256Hex(logo) });
    const buffer = buildZip([
      { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) },
      { name: 'plugin.js', content: pluginJs },
      { name: 'logo.png', content: logo },
    ]);
    await expectRefusal(buffer, 'PLUGIN_UNSIGNED');
  });

  it('unsignedProcessAllowlist: an unsigned process archive is accepted when its id is on the list', async () => {
    const pluginJs = Buffer.from('module.exports = {};');
    const logo = pngLogo();
    const manifest = minimalProcessManifest(
      { 'plugin.js': sha256Hex(pluginJs), 'logo.png': sha256Hex(logo) },
      { id: 'fliks.allowedunsigned' },
    );
    const buffer = buildZip([
      { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) },
      { name: 'plugin.js', content: pluginJs },
      { name: 'logo.png', content: logo },
    ]);

    const result = await inspect(buffer, { unsignedProcessAllowlist: ['fliks.allowedunsigned'] });
    expect(result.ok).toBe(true);
  });

  it('unsignedProcessAllowlist: an unsigned process archive is still refused when its id is not on the list', async () => {
    const pluginJs = Buffer.from('module.exports = {};');
    const logo = pngLogo();
    const manifest = minimalProcessManifest(
      { 'plugin.js': sha256Hex(pluginJs), 'logo.png': sha256Hex(logo) },
      { id: 'fliks.notallowed' },
    );
    const buffer = buildZip([
      { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) },
      { name: 'plugin.js', content: pluginJs },
      { name: 'logo.png', content: logo },
    ]);

    const result = await inspect(buffer, { unsignedProcessAllowlist: ['fliks.allowedunsigned'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PLUGIN_UNSIGNED');
  });

  it('PLUGIN_TIER_VIOLATION: a data-tier archive carrying plugin.js', async () => {
    const { entries } = signedManifestEntries(minimalDataManifest());
    const buffer = buildZip([...entries, { name: 'plugin.js', content: Buffer.from('x') }]);
    await expectRefusal(buffer, 'PLUGIN_TIER_VIOLATION');
  });

  it('PLUGIN_TIER_VIOLATION: a process-tier archive missing plugin.js', async () => {
    const logo = pngLogo();
    const manifest = minimalProcessManifest({ 'logo.png': sha256Hex(logo) });
    const { entries } = signedManifestEntries(manifest);
    const buffer = buildZip([...entries, { name: 'logo.png', content: logo }]);
    await expectRefusal(buffer, 'PLUGIN_TIER_VIOLATION');
  });

  it('PLUGIN_FILE_SET_MISMATCH: manifest.files omits an archive entry', async () => {
    const pluginJs = Buffer.from('module.exports = {};');
    const logo = pngLogo();
    // files{} is missing the logo.png hash entirely.
    const manifest = minimalProcessManifest({ 'plugin.js': sha256Hex(pluginJs) });
    const { entries } = signedManifestEntries(manifest);
    const buffer = buildZip([...entries, { name: 'plugin.js', content: pluginJs }, { name: 'logo.png', content: logo }]);
    await expectRefusal(buffer, 'PLUGIN_FILE_SET_MISMATCH');
  });
});
