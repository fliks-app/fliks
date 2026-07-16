import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: true;
}

export interface FsListing {
  /** Absolute path being listed; empty string = the roots view. */
  current: string;
  /** Path to navigate up to, `''` for the roots view, `null` at the top. */
  parent: string | null;
  entries: FsEntry[];
}

/** Server-side directory browser backing the admin folder picker. Lists
 *  sub-directories only (folders are what libraries/scan target); on Windows
 *  the roots view is the set of drive letters. */
@Injectable()
export class FilesystemService {
  list(inputPath?: string): FsListing {
    const trimmed = inputPath?.trim();
    if (!trimmed) return this.listRoots();

    const dir = path.resolve(trimmed);
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new BadRequestException(
        `Cannot read "${dir}": ${(err as Error).message}`,
      );
    }

    const entries: FsEntry[] = dirents
      .filter((d) => {
        try {
          return d.isDirectory();
        } catch {
          return false;
        }
      })
      .map((d) => ({
        name: d.name,
        path: path.join(dir, d.name),
        isDirectory: true as const,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { current: dir, parent: this.parentOf(dir), entries };
  }

  private listRoots(): FsListing {
    if (process.platform === 'win32') {
      const entries: FsEntry[] = [];
      for (let code = 65; code <= 90; code++) {
        const root = `${String.fromCharCode(code)}:\\`;
        try {
          if (fs.existsSync(root)) {
            entries.push({ name: root, path: root, isDirectory: true });
          }
        } catch {
          // Inaccessible drive — skip.
        }
      }
      return { current: '', parent: null, entries };
    }
    return this.list('/');
  }

  private parentOf(dir: string): string | null {
    // Windows drive root (`C:\`) goes back to the drive list.
    if (process.platform === 'win32' && /^[A-Za-z]:\\?$/.test(dir)) return '';
    const parent = path.dirname(dir);
    return parent === dir ? null : parent;
  }
}
