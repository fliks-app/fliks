import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractToStaging, writeGuardedFile } from './extract';
import { buildZip } from './zip-builder';
import { minimalDataManifest, minimalProcessManifest } from './test-manifests';
import { pngLogo, sha256Hex, svgLogo } from './test-fixtures';

describe('extractToStaging() — happy path', () => {
  it('extracts a process archive and hashes match manifest.files', async () => {
    const pluginJs = Buffer.from('module.exports = {};', 'utf8');
    const logo = pngLogo();
    const files = { 'plugin.js': sha256Hex(pluginJs), 'logo.png': sha256Hex(logo) };
    const manifest = minimalProcessManifest(files);
    const buffer = buildZip([
      { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) },
      { name: 'plugin.js', content: pluginJs },
      { name: 'logo.png', content: logo },
    ]);

    const result = await extractToStaging(buffer, manifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      expect(statSync(result.dir).mode & 0o777).toBe(0o700);
      const byName = new Map(result.files.map((f) => [f.name, f]));
      expect(byName.get('plugin.js')?.sha256).toBe(files['plugin.js']);
      expect(byName.get('logo.png')?.sha256).toBe(files['logo.png']);
      expect(readFileSync(byName.get('plugin.js')!.path)).toEqual(pluginJs);
      expect(statSync(byName.get('plugin.js')!.path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(result.dir, { recursive: true, force: true });
    }
  });

  it('extracts a data archive without a files{} map (nothing to hash-check)', async () => {
    const manifest = minimalDataManifest();
    const logo = svgLogo();
    const buffer = buildZip([
      { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) },
      { name: 'logo.svg', content: logo },
    ]);

    const result = await extractToStaging(buffer, manifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    rmSync(result.dir, { recursive: true, force: true });
  });
});

describe('extractToStaging() — guards', () => {
  it('PLUGIN_HASH_MISMATCH: extracted content does not match the declared hash', async () => {
    const pluginJs = Buffer.from('module.exports = {};');
    const logo = pngLogo();
    // Declare a hash that matches nothing actually in the archive.
    const manifest = minimalProcessManifest({ 'plugin.js': 'f'.repeat(64), 'logo.png': sha256Hex(logo) });
    const buffer = buildZip([
      { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) },
      { name: 'plugin.js', content: pluginJs },
      { name: 'logo.png', content: logo },
    ]);

    const result = await extractToStaging(buffer, manifest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PLUGIN_HASH_MISMATCH');
  });

  it('PLUGIN_BAD_LOGO: an SVG carrying a <script> element', async () => {
    const manifest = minimalDataManifest();
    const evilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const buffer = buildZip([
      { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) },
      { name: 'logo.svg', content: evilSvg },
    ]);

    const result = await extractToStaging(buffer, manifest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PLUGIN_BAD_LOGO');
  });

  it('PLUGIN_BAD_LOGO: a logo.png with the wrong magic bytes', async () => {
    const manifest = minimalDataManifest({ logo: 'logo.png' });
    const buffer = buildZip([
      { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) },
      { name: 'logo.png', content: Buffer.from('this is not a png') },
    ]);

    const result = await extractToStaging(buffer, manifest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PLUGIN_BAD_LOGO');
  });

  it('purges the staging directory on refusal — no partial installs', async () => {
    const pluginJs = Buffer.from('module.exports = {};');
    const manifest = minimalProcessManifest({ 'plugin.js': 'f'.repeat(64) });
    const buffer = buildZip([
      { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest)) },
      { name: 'plugin.js', content: pluginJs },
    ]);

    const before = stagingDirCount();
    const result = await extractToStaging(buffer, manifest);
    expect(result.ok).toBe(false);
    expect(stagingDirCount()).toBe(before);
  });
});

describe('writeGuardedFile() — symlink escape at the write target', () => {
  it('refuses to follow a symlink already at the target path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fliks-plugin-test-'));
    const outsideFile = join(dir, 'outside.txt');
    writeFileSync(outsideFile, 'untouched');
    const target = join(dir, 'plugin.js');
    symlinkSync(outsideFile, target);

    try {
      let code: string | undefined;
      try {
        writeGuardedFile(target, Buffer.from('payload'));
      } catch (err) {
        code = (err as NodeJS.ErrnoException).code;
      }
      expect(code).toBe('EEXIST');
      expect(readFileSync(outsideFile, 'utf8')).toBe('untouched');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Counts `fliks-plugin-*` mkdtemp directories left behind in the OS temp dir, as a leak check. */
function stagingDirCount(): number {
  return readdirSync(tmpdir()).filter((n) => n.startsWith('fliks-plugin-')).length;
}
