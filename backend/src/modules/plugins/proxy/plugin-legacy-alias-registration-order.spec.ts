import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../../../app.module';
import { PluginLegacyAliasModule } from './plugin-legacy-alias.module';

const SRC_ROOT = join(__dirname, '..', '..', '..');

function moduleFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) moduleFiles(full, found);
    else if (entry.endsWith('.module.ts')) found.push(full);
  }
  return found;
}

/**
 * `PluginLegacyAliasController` answers an app-wide `*splat`, and Express matches routes in
 * registration order — so anything registered after it is unreachable. Nest's registration
 * order is the module *scan* order, not `AppModule`'s import array: a module another module
 * imports is inserted where that importer is reached. Both facts below are what keeps the
 * catch-all last; each has already cost one production 404 on a real core route.
 */
describe('legacy-alias catch-all registration order', () => {
  it('is the last module AppModule imports', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) as unknown[]) ?? [];
    expect(imports.length).toBeGreaterThan(1);
    expect(imports[imports.length - 1]).toBe(PluginLegacyAliasModule);
  });

  it('VERDICT: no other module imports it — one importer scanned earlier moves the catch-all ahead of core routes', () => {
    const offenders = moduleFiles(SRC_ROOT)
      .filter((f) => !f.endsWith('plugin-legacy-alias.module.ts') && !f.endsWith('app.module.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes('PluginLegacyAliasModule'));

    expect(offenders).toEqual([]);
  });
});
