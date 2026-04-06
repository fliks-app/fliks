import * as path from 'path';
import { Repository } from 'typeorm';
import { RootFolder } from '../root-folders/entities/root-folder.entity';

/** Insert missing root folders by path (same behavior as Radarr/Sonarr API reconcile). */
export async function ensureRootFolderPathsExist(
  repo: Repository<RootFolder>,
  paths: string[],
  createdOut: string[],
): Promise<void> {
  const existing = await repo.find();
  const existingPaths = new Set(
    existing.map((f) => f.path.replace(/\/+$/, '')),
  );
  for (const raw of paths) {
    if (!raw?.trim()) continue;
    const normalized = raw.replace(/\/+$/, '');
    if (!existingPaths.has(normalized)) {
      try {
        await repo.save(repo.create({ path: raw.trim() }));
        createdOut.push(raw.trim());
        existingPaths.add(normalized);
      } catch {
        /* duplicate or DB error */
      }
    }
  }
}

/**
 * Map Radarr/Sonarr full library path + optional API rootFolderPath to our
 * rootFolderId + folderName (Media.path is computed from these).
 */
export function resolveRootFolderFromArrPaths(
  fullPath: string | undefined | null,
  rootFolderPathFromApi: string | undefined | null,
  rootFolders: RootFolder[],
): { rootFolderId: number; folderName: string } | null {
  if (!rootFolders.length) return null;

  const norm = (p: string) =>
    path
      .normalize(p.trim())
      .replace(/[/\\]+$/, '')
      .replace(/\\/g, '/');

  const sorted = [...rootFolders].sort(
    (a, b) => norm(b.path).length - norm(a.path).length,
  );

  const full = fullPath?.trim() ? norm(fullPath) : '';
  const apiRoot = rootFolderPathFromApi?.trim()
    ? norm(rootFolderPathFromApi)
    : '';

  if (full) {
    for (const rf of sorted) {
      const root = norm(rf.path);
      if (full === root) {
        return { rootFolderId: rf.id, folderName: path.basename(full) };
      }
      const prefix = root + '/';
      if (full.startsWith(prefix)) {
        const rel = full.slice(prefix.length);
        const folderName = rel.split('/')[0] || path.basename(full);
        if (folderName) {
          return { rootFolderId: rf.id, folderName };
        }
      }
    }
  }

  if (apiRoot && full) {
    const rf = sorted.find((f) => norm(f.path) === apiRoot);
    if (rf) {
      const prefix = apiRoot + '/';
      if (full.startsWith(prefix)) {
        const rel = full.slice(prefix.length);
        const folderName = rel.split('/')[0] || path.basename(full);
        if (folderName) {
          return { rootFolderId: rf.id, folderName };
        }
      }
    }
  }

  return null;
}
