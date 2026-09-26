import { randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';

/** Names every temp file `writeAtomically` leaves beside its destination. */
export const ATOMIC_TEMP_PREFIX = '.fliks-tmp-';

/** Rename errors a scanner or indexer holding the file raises on Windows. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 100;

export async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      await new Promise((r) => setTimeout(r, RENAME_RETRY_MS));
    }
  }
}

/** Produce `dest` through `write(tmp)`: a fixed-length temp in its directory, so
 *  the rename is atomic and never past NAME_MAX, one per writer. */
export async function writeAtomically(
  dest: string,
  write: (tmp: string) => Promise<void>,
): Promise<void> {
  const tmp = path.join(path.dirname(dest), `${ATOMIC_TEMP_PREFIX}${randomUUID()}`);
  try {
    await write(tmp);
    await renameRetrying(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function writeFileAtomic(dest: string, data: Buffer | string): Promise<void> {
  return writeAtomically(dest, (tmp) => fsp.writeFile(tmp, data));
}
