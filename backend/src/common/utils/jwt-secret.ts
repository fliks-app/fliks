import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import * as os from 'os';
import { Logger } from '@nestjs/common';
import { resolveWritableDir } from '../constants/writable-dir';

const logger = new Logger('JwtSecret');

/**
 * Resolve the JWT signing secret without forcing the operator to set
 * one. Strategy:
 *
 *   1. If `JWT_SECRET` is in the environment, use it (lets operators
 *      rotate without touching the file, or pin a known value across
 *      multiple replicas).
 *   2. Otherwise, read it from `<conf-dir>/.jwt-secret` if the file
 *      exists.
 *   3. On first boot, generate a fresh 256-bit secret, write it to
 *      that file with `0600` perms inside a `0700` directory, and
 *      return it.
 *
 * The conf directory defaults to `/app/conf` (mountable as a Docker
 * volume so the secret survives container restarts and image
 * rebuilds). Override with `FLIKS_CONF_DIR` for local dev where
 * `/app/conf` is not writable. If neither is writable (e.g. the volume
 * is root-owned and the container runs as a pinned uid), falls back to
 * a temp dir so boot still succeeds — the secret then won't survive a
 * restart.
 *
 * Sync I/O is intentional: this runs once at module init, before the
 * HTTP server starts accepting requests. Async would force the
 * AuthModule to be async-everything and gain nothing.
 *
 * Result is cached for the process lifetime — every JWT sign /
 * verify reads from memory, never the disk.
 */
let cachedConfDir: string | null = null;
function confDir(): string {
  if (cachedConfDir) return cachedConfDir;
  const override = process.env.FLIKS_CONF_DIR?.trim();
  cachedConfDir = resolveWritableDir(
    [override || '/app/conf', join(os.tmpdir(), 'fliks-conf')],
    'Cannot write to the JWT conf directory — JWT_SECRET will be ' +
      'regenerated on every restart and every session invalidated. Set ' +
      'JWT_SECRET directly, or make FLIKS_CONF_DIR (default /app/conf) ' +
      'writable for this container user.',
    0o700,
  );
  return cachedConfDir;
}

let cached: string | null = null;

export function getJwtSecret(): string {
  if (cached) return cached;

  if (process.env.JWT_SECRET) {
    cached = process.env.JWT_SECRET;
    return cached;
  }

  const dir = confDir();
  const file = join(dir, '.jwt-secret');

  try {
    if (existsSync(file)) {
      cached = readFileSync(file, 'utf8').trim();
      return cached;
    }

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const secret = randomBytes(32).toString('hex');
    writeFileSync(file, secret, { mode: 0o600 });
    cached = secret;
    return secret;
  } catch (err) {
    // resolveWritableDir already probed `dir` — this only fires on a race
    // or a read failure on an existing file it can no longer access.
    logger.warn(
      `Cannot persist JWT secret in ${dir} (${(err as Error).message}) — ` +
        'using an in-memory secret for this process only.',
    );
    cached = randomBytes(32).toString('hex');
    return cached;
  }
}
