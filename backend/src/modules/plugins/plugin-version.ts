import * as fs from 'fs';
import * as path from 'path';

/** A leaf so the registry, the catalog client and the supervisor can all read this
 *  without cycling through each other. Same pattern as `UpdateCheckService`/`SystemController`. */
export const CURRENT_FLIKS_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
