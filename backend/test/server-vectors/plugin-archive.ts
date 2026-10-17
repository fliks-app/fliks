import { createPrivateKey, sign } from 'crypto';
import { inspect } from '../../src/modules/plugins/archive/zip-inspector';
import { buildZip, ZipEntrySpec, ZipBuildOptions } from '../../src/modules/plugins/archive/zip-builder';
import { minimalDataManifest } from '../../src/modules/plugins/archive/test-manifests';
import { readArchiveEntries, sniffLogo } from '../../src/modules/plugins/archive/extract';
import { pngLogo, svgLogo } from '../../src/modules/plugins/archive/test-fixtures';
import { emit } from './_util';

// A fixed key: an unknown signer, so the expected outcome does not depend on a random key.
const KEY = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8',
});
const signed = (manifest: unknown): ZipEntrySpec[] => {
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  return [
    { name: 'plugin.json', content: bytes },
    { name: 'plugin.json.sig', content: Buffer.from(sign(null, bytes, KEY).toString('base64')) },
  ];
};
const data = (o: Record<string, unknown> = {}) => minimalDataManifest(o as never);
const ok = () => [...signed(data()), { name: 'logo.svg', content: svgLogo() }];
const zip = (entries: ZipEntrySpec[], options?: ZipBuildOptions) => buildZip(entries, options);
const unsignedData = (m: unknown) => zip([{ name: 'plugin.json', content: Buffer.from(JSON.stringify(m)) }, { name: 'logo.svg', content: svgLogo() }]);

const CASES: Record<string, Buffer> = {
  'ok-signed-data': zip(ok()),
  'ok-unsigned-data': unsignedData(data()),
  'ok-png-logo': zip([...signed(data({ logo: 'logo.png' })), { name: 'logo.png', content: pngLogo() }]),
  'ok-deflate': zip(ok().map((e) => ({ ...e, compressionMethod: 8 }))),
  'ok-perm-bits': zip(ok().map((e) => ({ ...e, externalFileAttributes: (0o600 << 16) >>> 0 }))),
  'ok-sig-trailing-newline': zip([...signed(data()).map((e) => (e.name === 'plugin.json.sig' ? { ...e, content: Buffer.concat([e.content, Buffer.from('\n')]) } : e)), { name: 'logo.svg', content: svgLogo() }]),
  'bad-magic': Buffer.concat([Buffer.from('xx'), zip(ok())]),
  'empty': Buffer.alloc(0),
  'trailing-data': zip(ok(), { trailingBytes: Buffer.from('garbage') }),
  'two-archives': Buffer.concat([zip(ok()), zip(ok())]),
  'comment': zip(ok(), { archiveComment: 'hi' }),
  'too-many-entries': zip([...ok(), { name: 'plugin.js', content: Buffer.from('x') }, { name: 'logo.png', content: pngLogo() }]),
  'control-char': zip([{ name: 'logo\u0000.svg', content: svgLogo() }]),
  'not-nfc': zip([{ name: 'logó.svg', content: svgLogo() }]),
  'path-separator': zip([{ name: 'sub/plugin.json', content: Buffer.from('{}') }]),
  'backslash': zip([{ name: 'sub\\plugin.json', content: Buffer.from('{}') }]),
  'absolute': zip([{ name: '/etc/passwd', content: Buffer.from('x') }]),
  'drive-letter': zip([{ name: 'C:evil.txt', content: Buffer.from('x') }]),
  'duplicate-record': zip([{ name: 'plugin.json', content: Buffer.from('{}') }], { duplicateCentralDirectoryRecords: [0] }),
  'duplicate-case': zip([{ name: 'plugin.json', content: Buffer.from('{}') }, { name: 'PLUGIN.JSON', content: Buffer.from('{}') }]),
  'two-logos': zip([...signed(data()), { name: 'logo.svg', content: svgLogo() }, { name: 'logo.png', content: pngLogo() }]),
  'directory-bit': zip([{ name: 'logo.svg', content: svgLogo(), externalFileAttributes: 0x10 }]),
  'symlink': zip([{ name: 'logo.png', content: pngLogo(), externalFileAttributes: (0xa1ff << 16) >>> 0 }]),
  'unexpected-entry': zip([{ name: 'README.md', content: Buffer.from('hi') }]),
  'zip64': zip([{ name: 'logo.svg', content: svgLogo(), extraFields: [{ id: 0x0001, data: Buffer.alloc(0) }] }]),
  'data-descriptor': zip([{ name: 'logo.svg', content: svgLogo(), generalPurposeBitFlag: 0x0808 }]),
  'encrypted': zip([{ name: 'logo.svg', content: svgLogo(), compressionMethod: 8, generalPurposeBitFlag: 0x0801 }]),
  'compression-method': zip([{ name: 'logo.svg', content: svgLogo(), compressionMethod: 99 }]),
  'manifest-too-large': zip([{ name: 'plugin.json', content: Buffer.alloc(300 * 1024, 0x7b), compressionMethod: 8 }]),
  'logo-too-large': zip([{ name: 'logo.png', content: Buffer.alloc(70 * 1024, 0x41), compressionMethod: 8 }]),
  'ratio': zip([{ name: 'logo.svg', content: Buffer.alloc(20000, 0), compressionMethod: 8 }]),
  'lying-size': zip([{ name: 'plugin.json', content: Buffer.alloc(5000, 0x41), compressionMethod: 8, declaredUncompressedSize: 100 }]),
  'bad-crc': zip([{ name: 'logo.svg', content: svgLogo(), declaredCrc32: 1 }]),
  'bad-json': zip([{ name: 'plugin.json', content: Buffer.from('{not json') }]),
  'missing-field': unsignedData({ ...data(), name: undefined }),
  'unknown-key': unsignedData({ ...data(), extra: 1 }),
  'short-signature': zip([{ name: 'plugin.json', content: Buffer.from(JSON.stringify(data())) }, { name: 'plugin.json.sig', content: Buffer.from(Buffer.from('too short').toString('base64')) }]),
  'wrong-signature': zip([...signed(data({ name: 'Other' })).map((e) => (e.name === 'plugin.json' ? { ...e, content: Buffer.from(JSON.stringify(data())) } : e)), { name: 'logo.svg', content: svgLogo() }]),
  'bad-id': unsignedData(data({ id: 'fliks.Test-Plugin' })),
  'bad-version': unsignedData(data({ version: 'not-a-version' })),
  'missing-logo': zip(signed(data())),
  'logo-mismatch': zip([...signed(data({ logo: 'logo.png' })), { name: 'logo.svg', content: svgLogo() }]),
  'bad-svg': zip([...signed(data()), { name: 'logo.svg', content: Buffer.from('<svg onload="x()"></svg>') }]),
  'bad-png': zip([...signed(data({ logo: 'logo.png' })), { name: 'logo.png', content: Buffer.from('not a png') }]),
  'bad-ui': unsignedData({ ...data(), ui: 3 }),
};

const inputs: { name: string; archive: string; pad?: number }[] = Object.entries(CASES).map(([name, buf]) => ({ name, archive: buf.toString('base64') }));
// Zero bytes appended past both caps (8 MiB in Nest, 33 MiB in Rust), so the fixture stays small.
inputs.push({ name: 'too-large', archive: zip(ok()).toString('base64'), pad: 33 * 1024 * 1024 });

async function run(i: { archive: string; pad?: number }): Promise<unknown> {
  const buf = Buffer.concat([Buffer.from(i.archive, 'base64'), Buffer.alloc(i.pad ?? 0)]);
  const r = await inspect(buf);
  // Nest sniffs the logo at extraction; rule 13 runs it with the archive guards.
  if (r.ok) {
    const logos = await readArchiveEntries(buf, new Set(['logo.svg', 'logo.png']));
    for (const [name, content] of logos) {
      const bad = sniffLogo(name, content);
      if (bad) return { code: bad.code };
    }
  }
  return r.ok ? { ok: true, id: r.id, version: r.version, kind: r.kind, sha256: r.sha256, signature: r.signature } : { code: r.code };
}

void emit('plugin-archive', inputs, run);
