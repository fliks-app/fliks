import { closeSync, mkdirSync, openSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';

const logger = new Logger('WritableDir');

/**
 * First candidate directory that accepts a real write. Probes by opening
 * `.probe` for writing and deleting it — `fs.access` is not enough, it
 * reports writable under some ACL/overlay-mount setups that then reject
 * the actual write. Falls back to the last candidate (best effort, logging
 * `warning`) if none of them are writable.
 */
export function resolveWritableDir(
  candidates: string[],
  warning: string,
  mode?: number,
): string {
  for (let i = 0; i < candidates.length; i++) {
    const dir = candidates[i];
    try {
      mkdirSync(dir, { recursive: true, mode });
      const probe = join(dir, '.probe');
      closeSync(openSync(probe, 'w'));
      unlinkSync(probe);
      if (i > 0) logger.warn(warning);
      return dir;
    } catch {
      // try the next candidate
    }
  }
  logger.warn(warning);
  return candidates[candidates.length - 1];
}
