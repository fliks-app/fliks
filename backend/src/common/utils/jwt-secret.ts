import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';

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
 * `/app/conf` is not writable.
 *
 * Sync I/O is intentional: this runs once at module init, before the
 * HTTP server starts accepting requests. Async would force the
 * AuthModule to be async-everything and gain nothing.
 *
 * Result is cached for the process lifetime — every JWT sign /
 * verify reads from memory, never the disk.
 */
const CONF_DIR = process.env.FLIKS_CONF_DIR || '/app/conf';
const JWT_SECRET_FILE = join(CONF_DIR, '.jwt-secret');

let cached: string | null = null;

export function getJwtSecret(): string {
  if (cached) return cached;

  if (process.env.JWT_SECRET) {
    cached = process.env.JWT_SECRET;
    return cached;
  }

  if (existsSync(JWT_SECRET_FILE)) {
    cached = readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    return cached;
  }

  mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
  cached = secret;
  return secret;
}
