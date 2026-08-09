import { Injectable, HttpStatus } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPluginsRuntimeDir } from '../../common/constants/paths';
import { PluginInstallException } from './plugin-install.exception';

/** `plans/plugin-system.plan.md`, "Staging disk-fill" guard. */
export const MAX_CONCURRENT_STAGED_IMPORTS = 5;
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const ARCHIVE_FILENAME = 'archive.zip';

/**
 * Holds a manually-uploaded archive on disk between `inspect` and `confirm`,
 * so `confirm` never has to trust an in-memory buffer that a second HTTP
 * call away might no longer match a writable directory's actual bytes.
 * Directory name = `sha256(zip).slice(0, 32)`, so re-staging identical bytes
 * is a no-op rather than a second directory.
 */
@Injectable()
export class PluginStagingService {
  private root(): string {
    return join(getPluginsRuntimeDir(), 'import-staging');
  }

  private dirFor(stagingId: string): string {
    return join(this.root(), stagingId);
  }

  /** Idempotent on content: identical bytes reuse the existing directory and never count twice against the cap. */
  stage(buffer: Buffer): { stagingId: string; sha256: string } {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const stagingId = sha256.slice(0, 32);
    const archivePath = join(this.dirFor(stagingId), ARCHIVE_FILENAME);
    if (existsSync(archivePath)) return { stagingId, sha256 };

    if (this.listStagingIds().length >= MAX_CONCURRENT_STAGED_IMPORTS) {
      throw new PluginInstallException(
        HttpStatus.TOO_MANY_REQUESTS,
        'PLUGIN_STAGING_LIMIT',
        `at most ${MAX_CONCURRENT_STAGED_IMPORTS} staged installs may exist at once — confirm or wait for one to be swept`,
      );
    }

    mkdirSync(this.dirFor(stagingId), { recursive: true, mode: 0o700 });
    writeFileSync(archivePath, buffer, { mode: 0o600 });
    return { stagingId, sha256 };
  }

  /** Fresh read off disk — the whole point of the second guard pass at confirm. */
  read(stagingId: string): Buffer {
    const archivePath = join(this.dirFor(stagingId), ARCHIVE_FILENAME);
    if (!existsSync(archivePath)) {
      throw new PluginInstallException(HttpStatus.NOT_FOUND, 'PLUGIN_STAGING_NOT_FOUND', `no staged upload "${stagingId}"`);
    }
    return readFileSync(archivePath);
  }

  discard(stagingId: string): void {
    rmSync(this.dirFor(stagingId), { recursive: true, force: true });
  }

  private listStagingIds(): string[] {
    try {
      return readdirSync(this.root());
    } catch {
      return [];
    }
  }

  /** Same `@nestjs/schedule` mechanism `PluginCatalogClientService` already declares its cron on. */
  @Cron(CronExpression.EVERY_HOUR)
  sweep(): void {
    const root = this.root();
    const cutoff = Date.now() - STAGING_MAX_AGE_MS;
    for (const id of this.listStagingIds()) {
      const dir = join(root, id);
      try {
        if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
      } catch {
        // removed between the listing and the stat — nothing to sweep
      }
    }
  }
}
