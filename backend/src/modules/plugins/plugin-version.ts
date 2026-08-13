import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';

/** Nearest `package.json` at or above `from`: walked, because `__dirname` sits at a different
 *  depth in `src/` than in `dist/`. */
export function readVersionFrom(from: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // keep walking up
    }
    if (dir === path.dirname(dir)) return null;
  }
}

/** A leaf so the registry, the catalog client and the supervisor can all read this
 *  without cycling through each other. Same pattern as `UpdateCheckService`/`SystemController`. */
export const CURRENT_FLIKS_VERSION: string = (() => {
  const found = readVersionFrom(__dirname) ?? readVersionFrom(process.cwd());
  if (found) return found;
  // `0.0.0` satisfies no plugin's declared range, so every plugin would be refused as incompatible.
  new Logger('PluginVersion').error('could not read the Fliks version — every plugin will be refused as incompatible');
  return '0.0.0';
})();
