import { existsSync, readdirSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { PluginStagingService, MAX_CONCURRENT_STAGED_IMPORTS } from './plugin-staging.service';
import { PluginInstallException } from './plugin-install.exception';
import { getPluginsRuntimeDir } from '../../common/constants/paths';

function stagingRoot(): string {
  return join(getPluginsRuntimeDir(), 'import-staging');
}

describe('PluginStagingService', () => {
  let service: PluginStagingService;

  beforeEach(() => {
    rmSync(stagingRoot(), { recursive: true, force: true });
    service = new PluginStagingService();
  });

  afterAll(() => {
    rmSync(stagingRoot(), { recursive: true, force: true });
  });

  it('stages a buffer under a directory named after its sha256, and reads it back unchanged', () => {
    const buffer = Buffer.from('one archive');
    const { stagingId, sha256 } = service.stage(buffer);

    expect(stagingId).toBe(sha256.slice(0, 32));
    expect(service.read(stagingId)).toEqual(buffer);
  });

  it('re-staging identical bytes reuses the existing directory rather than creating a second', () => {
    const buffer = Buffer.from('same content every time');
    const first = service.stage(buffer);
    const second = service.stage(buffer);

    expect(second.stagingId).toBe(first.stagingId);
    expect(readdirSync(stagingRoot())).toEqual([first.stagingId]);
  });

  it('reading an unknown staging id refuses with PLUGIN_STAGING_NOT_FOUND', () => {
    expect(() => service.read('0'.repeat(32))).toThrow(PluginInstallException);
    try {
      service.read('0'.repeat(32));
    } catch (err) {
      expect((err as PluginInstallException).getStatus()).toBe(404);
      expect((err as PluginInstallException).code).toBe('PLUGIN_STAGING_NOT_FOUND');
    }
  });

  it('refuses a new staging directory once the concurrent cap is reached', () => {
    for (let i = 0; i < MAX_CONCURRENT_STAGED_IMPORTS; i++) {
      service.stage(Buffer.from(`distinct archive ${i}`));
    }

    expect(() => service.stage(Buffer.from('one too many'))).toThrow(PluginInstallException);
    try {
      service.stage(Buffer.from('one too many'));
    } catch (err) {
      expect((err as PluginInstallException).getStatus()).toBe(429);
      expect((err as PluginInstallException).code).toBe('PLUGIN_STAGING_LIMIT');
    }
  });

  it('defaults to a manual origin and records a catalog origin when given one', () => {
    const manual = service.stage(Buffer.from('manual archive'));
    const catalog = service.stage(Buffer.from('catalog archive'), 'catalog');

    expect(service.originFor(manual.stagingId)).toBe('manual');
    expect(service.originFor(catalog.stagingId)).toBe('catalog');
  });

  it('reports manual for a staging id whose directory has no recorded origin', () => {
    expect(service.originFor('0'.repeat(32))).toBe('manual');
  });

  it('discard removes a staged directory', () => {
    const { stagingId } = service.stage(Buffer.from('to be discarded'));
    service.discard(stagingId);
    expect(existsSync(join(stagingRoot(), stagingId))).toBe(false);
  });

  it('sweep removes only entries older than the retention window', () => {
    const fresh = service.stage(Buffer.from('fresh'));
    const stale = service.stage(Buffer.from('stale'));
    const staleDir = join(stagingRoot(), stale.stagingId);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(staleDir, twoHoursAgo, twoHoursAgo);

    service.sweep();

    expect(existsSync(join(stagingRoot(), fresh.stagingId))).toBe(true);
    expect(existsSync(staleDir)).toBe(false);
  });
});
