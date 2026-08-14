import { cpSync, mkdirSync, renameSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { getPluginsRuntimeDir } from '../../common/constants/paths';

/**
 * A leaf module with no dependency on either service that installs or supervises a plugin —
 * both need these, and importing one from the other is the cycle that bit this project once.
 */

/** `${runtime dir}/installed/<id>@<version>/` — exported for uninstall's own recomputation and for tests. */
export function installedPluginDir(pluginId: string, version: string): string {
  return join(getPluginsRuntimeDir(), 'installed', `${pluginId}@${version}`);
}

/** `${runtime dir}/data/<id>/` — keyed by id, not version, and outside `installed/`: a re-extraction
 *  (every ordinary start) or an upgrade's new version directory never touches it. */
export function pluginDataDir(pluginId: string): string {
  return join(getPluginsRuntimeDir(), 'data', pluginId);
}

/** Same-filesystem rename when possible; copy+remove is the only option across devices. */
export function promoteDir(srcDir: string, destDir: string): void {
  mkdirSync(dirname(destDir), { recursive: true });
  rmSync(destDir, { recursive: true, force: true });
  try {
    renameSync(srcDir, destDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    cpSync(srcDir, destDir, { recursive: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
}
