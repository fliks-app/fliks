import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getDataDir } from '../../common/constants/paths';

/**
 * Whole-database dump and restore through the postgres client tools.
 *
 * Connection settings come from the same `DB_*` variables TypeORM reads, so the
 * two can never point at different databases. The password travels in
 * `PGPASSWORD` and the tools are spawned without a shell: no quoting of
 * credentials, nothing for a value to escape into.
 */
@Injectable()
export class BackupService {
  /** Backups kept by {@link pruneOldBackups}: a week of dailies. */
  private static readonly KEEP = 7;
  private readonly log = new Logger(BackupService.name);
  /** Under the data dir, so backups survive an image upgrade. */
  private readonly backupDir = path.join(getDataDir(), 'backups');

  constructor(private readonly config: ConfigService) {}

  async createBackup(): Promise<{ filename: string; size: number }> {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `fliks-backup-${timestamp}.sql`;
    const filePath = path.join(this.backupDir, filename);

    this.log.log(`Creating backup: ${filename}`);
    const fd = fs.openSync(filePath, 'w');
    try {
      // --clean --if-exists: the restore runs against a populated database.
      // --no-privileges: grants name plugin roles a fresh cluster lacks; provisioning re-grants.
      await this.run(
        'pg_dump',
        [
          ...this.connectionArgs(),
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-privileges',
        ],
        fd,
      );
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(filePath, { force: true });
      throw err;
    }
    fs.closeSync(fd);

    const stat = fs.statSync(filePath);
    this.log.log(`Backup created: ${filename} (${stat.size} bytes)`);
    return { filename, size: stat.size };
  }

  listBackups(): { filename: string; size: number; date: string }[] {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs
      .readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.sql'))
      .map((filename) => {
        const stat = fs.statSync(path.join(this.backupDir, filename));
        return { filename, size: stat.size, date: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  deleteBackup(filename: string): void {
    const filePath = this.getBackupPath(filename);
    fs.rmSync(filePath, { force: true });
    this.log.log(`Backup deleted: ${filename}`);
  }

  /** Drop every backup past the newest {@link KEEP}, so the daily job can't
   *  fill the data volume. Returns the names removed. */
  pruneOldBackups(): string[] {
    const stale = this.listBackups().slice(BackupService.KEEP);
    for (const { filename } of stale) {
      fs.rmSync(path.join(this.backupDir, filename), { force: true });
    }
    return stale.map((b) => b.filename);
  }

  async restore(filename: string): Promise<void> {
    const filePath = this.getBackupPath(filename);
    this.log.warn(`Restoring backup: ${filename}`);
    await this.ensurePluginRoles(filePath);
    // ON_ERROR_STOP: without it psql reports success after skipping every failed
    // statement. --single-transaction rolls the whole restore back on the first error.
    await this.run('psql', [
      ...this.connectionArgs(),
      '--single-transaction',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      filePath,
    ]);
    this.log.log(`Backup restored: ${filename}`);
  }

  /** Older dumps grant to plugin roles; a missing one aborts the restore at its first GRANT. */
  private async ensurePluginRoles(filePath: string): Promise<void> {
    const roles = new Set<string>();
    const lines = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      const role = /^GRANT .+ TO (plugin_[a-z0-9_]{1,56});$/.exec(line)?.[1];
      if (role) roles.add(role);
    }
    if (roles.size === 0) return;
    const creates = [...roles]
      .map(
        (role) =>
          `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" LOGIN; END IF;`,
      )
      .join(' ');
    await this.run('psql', [
      ...this.connectionArgs(),
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `DO $$ BEGIN ${creates} END $$`,
    ]);
  }

  /** Resolved inside the backup dir: the name reaches here from a request. */
  getBackupPath(filename: string): string {
    if (!/^[\w.-]+\.sql$/.test(filename)) {
      throw new BadRequestException(`Invalid backup name "${filename}"`);
    }
    const filePath = path.join(this.backupDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`Backup "${filename}" not found`);
    }
    return filePath;
  }

  private connectionArgs(): string[] {
    return [
      '-h',
      this.config.get<string>('DB_HOST', 'localhost'),
      '-p',
      String(this.config.get<number>('DB_PORT', 5432)),
      '-U',
      this.config.get<string>('DB_USERNAME', 'fliks'),
      '-d',
      this.config.get<string>('DB_NAME', 'fliks'),
    ];
  }

  /** Spawn a postgres tool, optionally writing its stdout to `outFd`. Rejects
   *  with the tool's own last stderr line, which is what the UI shows. */
  private run(cmd: string, args: string[], outFd?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ['ignore', outFd ?? 'ignore', 'pipe'],
        env: {
          ...process.env,
          PGPASSWORD: this.config.get<string>('DB_PASSWORD', ''),
        },
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        reject(
          new InternalServerErrorException(
            err.code === 'ENOENT'
              ? `${cmd} is not available on this server`
              : `${cmd} failed: ${err.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        if (code === 0) return resolve();
        const detail = stderr.trim().split('\n').filter(Boolean).pop();
        this.log.error(`${cmd} exited with ${code}: ${stderr.trim()}`);
        reject(
          new InternalServerErrorException(
            detail ?? `${cmd} exited with code ${code}`,
          ),
        );
      });
    });
  }
}
