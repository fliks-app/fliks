import { createHash } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PackagingError, readPluginDir } from './package-plugin';
import { buildZip } from './zip-builder';
import { inspect } from './index';
import { minimalProcessManifest } from './test-manifests';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STALE_HASH = 'f'.repeat(64);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An author's build output, carrying a `files` map that is out of date — the usual mistake. */
function pluginDir(overrides: Record<string, unknown> = {}, code = 'module.exports = {};\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'pack-plugin-'));
  dirs.push(dir);
  const manifest = { ...minimalProcessManifest({ 'plugin.js': STALE_HASH }), ...overrides };
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'plugin.js'), code);
  // The fixture manifest declares a logo, so one has to be on disk; the magic bytes are all
  // `sniffLogo` reads.
  writeFileSync(join(dir, 'logo.png'), PNG_MAGIC);
  return dir;
}

function pack(dir: string): Buffer {
  return buildZip(readPluginDir(dir).map((e) => ({ name: e.name, content: e.content })));
}

describe('package-plugin', () => {
  it('produces an archive the real inspector accepts, with the hashes it computed itself', async () => {
    const result = await inspect(pack(pluginDir()), { unsignedProcessAllowlist: ['fliks.testprocessplugin'] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe('fliks.testprocessplugin');
    // The stale hash the author left behind is replaced, not carried into the archive.
    const files = result.manifest.kind === 'process' ? result.manifest.files : {};
    expect(Object.keys(files).sort()).toEqual(['logo.png', 'plugin.js']);
    expect(files['plugin.js']).not.toBe(STALE_HASH);
    expect(files['plugin.js']).toBe(createHash('sha256').update('module.exports = {};\n').digest('hex'));
  });

  it('refuses a directory carrying an entry an archive may not hold', () => {
    const dir = pluginDir();
    writeFileSync(join(dir, 'install.sh'), 'echo hi\n');
    expect(() => pack(dir)).toThrow(PackagingError);
    expect(() => pack(dir)).toThrow(/install\.sh/);
  });

  it('refuses a logo whose bytes are not the format its name claims', () => {
    const dir = pluginDir();
    writeFileSync(join(dir, 'logo.png'), 'not a png at all');
    expect(() => pack(dir)).toThrow(/PNG magic bytes/);
  });

  it('refuses a manifest the parser itself would reject', () => {
    const dir = pluginDir({ version: 'not-semver' });
    expect(() => pack(dir)).toThrow(PackagingError);
  });
});
